import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../src/harness/baseware.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen as listenRsa, send, type Request } from "../src/harness/transport.ts";
import type { RecordEvent } from "../src/harness/events.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error("Integration condition did not become true");
    await Bun.sleep(10);
  }
}

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-controller-")));
  const runDir = join(workspace, "logs/run");
  const prefix = `/tmp/rsa-ci-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const source = join(workspace, "frame.json");
  await writeFile(source, '{"visible":true}');
  const events: { type: string; data: any; trace: any }[] = [];
  const record: RecordEvent = (type, data, trace) => events.push({ type, data, trace });
  const actions: { argv: string[]; epoch: string }[] = [];
  let held = false, cancelled = 0, released = 0;
  const core = new BasewareCore({ drivers: [{ id: "offline", version: "1" }], capabilities: {
    controllers: [{ id: "pad", help: () => "echo <text> | wait | fail",
      async acquire() { held = true; }, async release() { held = false; released++; },
      async execute(argv, {epoch, signal}) {
        signal.throwIfAborted();
        actions.push({argv: [...argv], epoch});
        if (argv[0] === "wait") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelled++; resolve(); }, {once: true}));
        }
        return {id: crypto.randomUUID(), status: signal.aborted ? "interrupted" : argv[0] === "fail" ? "failed" : "completed",
          exitCode: signal.aborted ? 130 : argv[0] === "fail" ? 17 : 0, stdout: JSON.stringify(argv), stderr: "",
          timing: {clock: "offline", requestedAtMs: 1, receivedAtMs: 2}};
      },
    }],
    sensors: [{ id: "screen", mediaTypes: ["application/json"], help: () => "capture",
      async read() { return [{id: "frame", sensorId: "screen", mediaType: "application/json", path: source,
        timing: {clock: "offline", requestedAtMs: 3, receivedAtMs: 4}}]; },
    }],
  }});
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({socket: basewareSocket, seconds: 60, runDir, record});
  const runtime = new Runtime(devices, record, 60, "integration-run");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
    PATH: [dirname(process.execPath), join(import.meta.dir, "../bin"), process.env.PATH].join(":"),
    PYTHONPATH: join(import.meta.dir, "../python") };
  runtime.controller = new WorkspaceController({workspace, devices, env, record});
  devices.onHandback(reason => { void runtime.stop(reason); });
  devices.onDisconnect(error => { void runtime.disconnected(error); });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  async function run(command: string[], epoch?: string) {
    const child = Bun.spawn(command, {cwd: workspace,
      env: {...env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify({toolCallId: "integration-call"})},
      stdout: "pipe", stderr: "pipe"});
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {stdout, stderr, exitCode};
  }
  return {workspace, runDir, source, rsaSocket, runtime, core, actions, events,
    held: () => held, cancelled: () => cancelled, released: () => released,
    cli: (argv: string[], epoch?: string) => run([join(import.meta.dir, "../bin/rsa"), "controller", ...argv], epoch),
    python: (source: string, epoch: string) => run(["python3", "-B", "-c", source], epoch),
    async close() {
      await runtime.close(); devices.close(); await closeRsa(); await closeBaseware();
      await rm(workspace, {recursive: true, force: true});
      await rm(rsaSocket, {force: true});
    },
  };
}

test("CLI and Python compose the unified driver/workspace catalog, preserving observations and trace", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workspace, "scripts"));
    const path = join(f.workspace, "scripts/actions.py");
    const source = `from rsa_tools import Client, capability
from pathlib import Path
Path("imported").touch()
@capability
def echo(value: str = "hello") -> str:
    """Return a reusable label."""
    return "v1:" + value
@capability
def combined(label: str) -> dict:
    """Compose a driver call and another workspace capability."""
    client = Client()
    return {"motion": client.call("controller/pad", ["echo", label]),
            "label": client.call("python/scripts/actions.py:echo", {"value": label})}
`;
    await writeFile(path, source);
    const listed = await f.cli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).capabilities.map((item: any) => item.id)).toEqual([
      "controller/pad", "sensor/screen", "python/scripts/actions.py:echo", "python/scripts/actions.py:combined",
    ]);
    const help = await f.cli(["python/scripts/actions.py:echo", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.stdout).parameters.properties.value.default).toBe("hello");
    expect(await Bun.file(join(f.workspace, "imported")).exists()).toBe(false);

    const epoch = (await f.runtime.start()).epoch!;
    const literal = await f.cli(["controller/pad", "--args", "literal", "--help"], epoch);
    expect(literal.exitCode).toBe(0);
    expect(JSON.parse(literal.stdout).stdout).toBe('["--args","literal","--help"]');
    const combined = await f.python(`import json
from rsa_tools import Client
print(json.dumps(Client().call("python/scripts/actions.py:combined", {"label": "前进"})))`, epoch);
    expect(combined.stderr).toBe("");
    expect(combined.exitCode).toBe(0);
    expect(JSON.parse(combined.stdout)).toMatchObject({label: "v1:前进", motion: {status: "completed", stdout: '["echo","前进"]'}});
    expect(f.actions).toEqual([{argv: ["--args", "literal", "--help"], epoch}, {argv: ["echo", "前进"], epoch}]);
    const nested = f.events.filter(event => event.type === "python_capability");
    expect(nested).toHaveLength(2);
    for (const event of [...nested, ...f.events.filter(event => event.type === "execution")]) {
      expect(event.trace).toMatchObject({epoch, toolCallId: "integration-call"});
    }

    const captured = await f.cli(["sensor/screen", "capture"], epoch);
    expect(captured.exitCode).toBe(0);
    const [observation] = JSON.parse(captured.stdout);
    expect(observation.path.startsWith(join(f.runDir, "observations") + "/")).toBe(true);
    await rm(f.source);
    expect(await readFile(observation.path, "utf8")).toBe('{"visible":true}');
    expect(f.events.find(event => event.type === "observation")).toMatchObject({data: {path: observation.path}, trace: {epoch, toolCallId: "integration-call"}});

    await writeFile(path, source.replace('"v1:"', '"v2:"'));
    const changed = await f.cli(["python/scripts/actions.py:echo"], epoch);
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout.trim()).toBe("v2:hello");
    await rm(path);
    expect(JSON.parse((await f.cli(["list"])).stdout).capabilities.map((item: any) => item.id)).toEqual(["controller/pad", "sensor/screen"]);
    const removed = await f.cli(["python/scripts/actions.py:echo"], epoch);
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain("Unknown capability");
    expect((await f.cli(["controller/pad", "fail"], epoch)).exitCode).toBe(17);
  } finally { await f.close(); }
}, 15000);

test("caller disconnect and human handback cancel long calls, and a new epoch rejects the old caller", async () => {
  const f = await fixture();
  const clients: Socket[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const call = (epoch: string, id: string, args?: unknown) => ({kind: "controller", argv: [], action: "call", id, arguments: args, epoch} satisfies Request);
  async function disconnectable(request: Request) {
    const socket = connect(f.rsaSocket);
    clients.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(JSON.stringify(request) + "\n");
    return socket;
  }
  try {
    await writeFile(join(f.workspace, "actions.py"), `from rsa_tools import Client, capability
from pathlib import Path
import os, time
@capability
def wait(nested: bool = False):
    """Wait in Python or in a nested driver call."""
    Path("nested.pid" if nested else "python.pid").write_text(str(os.getpid()))
    if nested:
        return Client().call("controller/pad", ["wait"])
    time.sleep(30)
    Path("unexpected-completion").touch()
`);
    const epoch = (await f.runtime.start()).epoch!;
    const raw = await disconnectable(call(epoch, "controller/pad", ["wait"]));
    await until(() => f.actions.length === 1);
    raw.destroy();
    await until(() => f.cancelled() === 1);
    expect(f.core.status()).toMatchObject({mode: "auto", epoch});
    expect(f.held()).toBe(true);

    const python = await disconnectable(call(epoch, "python/actions.py:wait"));
    const pidFile = join(f.workspace, "python.pid");
    await until(() => Bun.file(pidFile).exists());
    const pid = Number(await readFile(pidFile, "utf8"));
    python.destroy();
    await until(() => !alive(pid));
    expect(await Bun.file(join(f.workspace, "unexpected-completion")).exists()).toBe(false);
    expect(f.runtime.status().mode).toBe("auto");

    const pending = send(f.rsaSocket, call(epoch, "python/actions.py:wait", {nested: true}));
    const outcome = pending.then(value => ({value, error: ""}), error => ({value: undefined, error: String(error)}));
    await until(() => f.actions.length === 2);
    const nestedPid = Number(await readFile(join(f.workspace, "nested.pid"), "utf8"));
    await f.runtime.stop();
    expect((await outcome).error).not.toBe("");
    await until(() => f.cancelled() === 2 && !alive(nestedPid));
    expect(f.held()).toBe(false);
    expect(f.released()).toBe(1);
    expect(f.core.status().mode).toBe("manual");
    expect(f.runtime.status().mode).toBe("manual");

    const nextEpoch = (await f.runtime.start()).epoch!;
    expect(nextEpoch).not.toBe(epoch);
    const stale = await f.cli(["controller/pad", "echo", "stale"], epoch);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("STALE_EPOCH");
    expect(f.actions).toHaveLength(2);
    expect(await send(f.rsaSocket, call(nextEpoch, "controller/pad", ["echo", "current"]))).toMatchObject({status: "completed"});
    expect(f.actions[2]).toEqual({argv: ["echo", "current"], epoch: nextEpoch});
  } finally {
    for (const socket of clients) socket.destroy();
    await f.close();
  }
}, 15000);
