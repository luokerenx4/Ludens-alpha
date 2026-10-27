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
import { captureResult } from "./runtime-fixture.ts";

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
  const events: { type: string; data: any; trace: any; metadata: any }[] = [];
  const record: RecordEvent = (type, data, trace, metadata) => events.push({ type, data, trace, metadata });
  const actions: { args: Record<string, unknown>; epoch?: string }[] = [];
  let held = false, cancelled = 0, released = 0;
  const core = new BasewareCore({ drivers: [{ id: "offline", version: "1" }], capabilities: {
    controllers: [{ tool: { name: "pad.echo", description: "Echo a label; wait/fail labels exercise cancellation and errors.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } }, requiresControl: true,
      async acquire() { held = true; }, async release() { held = false; released++; },
      async execute(args, {epoch, signal}) {
        signal.throwIfAborted();
        actions.push({args: {...args}, epoch});
        if (args.label === "wait") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelled++; resolve(); }, {once: true}));
        }
        return {id: crypto.randomUUID(), status: signal.aborted ? "interrupted" : args.label === "fail" ? "failed" : "completed",
          exitCode: signal.aborted ? 130 : args.label === "fail" ? 17 : 0, stdout: JSON.stringify(args), stderr: "", result: { content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: { ...args }, _meta: { native: true } },
          timing: {clock: "offline", requestedAtMs: 1, receivedAtMs: 2}};
      },
    }, { tool: { name: "screen.capture", description: "capture", inputSchema: { type: "object" } }, requiresControl: false, mediaTypes: ["application/json"],
      async execute() {
        const result = captureResult([{id: "frame", controllerId: "screen", mediaType: "application/json", path: source, contentIndex: 0,
          timing: {clock: "offline", requestedAtMs: 3, receivedAtMs: 4}}]);
        result.result = { content: [{ type: "resource", resource: { uri: "fixture:///frame", mimeType: "application/json",
          blob: Buffer.from('{"visible":true}').toString("base64") } }], _meta: { original: true } };
        return result;
      },
    }],
  }});
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({socket: basewareSocket, seconds: 60, runDir, record});
  const runtime = new Runtime(devices, record, 60, "integration-run");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, RSA_WORKSPACE: workspace, RSA_RUN_ID: "integration-run", BASEWARE_SOCKET: basewareSocket,
    PATH: [dirname(process.execPath), join(import.meta.dir, "../bin"), process.env.PATH].join(":"),
    PYTHONPATH: join(import.meta.dir, "../python") };
  runtime.controller = new WorkspaceController({workspace, devices, env, record});
  devices.onHandback(reason => { void runtime.stop(reason); });
  devices.onDisconnect(error => { void runtime.disconnected(error); });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  const parentTrace = { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", toolCallId: "integration-call" };
  async function run(command: string[], epoch?: string) {
    const child = Bun.spawn(command, {cwd: workspace,
      env: {...env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(parentTrace)},
      stdout: "pipe", stderr: "pipe"});
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {stdout, stderr, exitCode};
  }
  return {workspace, runDir, source, rsaSocket, runtime, core, actions, events, parentTrace,
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
    return {"motion": client.call("controller/pad.echo", {"label": label}),
            "label": client.call("python/scripts/actions.py:echo", {"value": label})}
`;
    await writeFile(path, source);
    const listed = await f.cli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).capabilities.map((item: any) => item.id)).toEqual([
      "controller/pad.echo", "controller/screen.capture", "python/scripts/actions.py:echo", "python/scripts/actions.py:combined",
    ]);
    const help = await f.cli(["python/scripts/actions.py:echo", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.stdout).parameters.properties.value.default).toBe("hello");
    expect(await Bun.file(join(f.workspace, "imported")).exists()).toBe(false);
    const driverHelp = JSON.parse((await f.cli(["controller/pad.echo", "--help"])).stdout);
    expect(driverHelp).toMatchObject({name: "pad.echo", inputSchema: {required: ["label"]}});

    const manualCapture = await f.cli(["controller/screen.capture"]);
    expect(manualCapture.exitCode).toBe(0);
    expect(JSON.parse(manualCapture.stdout)).toMatchObject({ status: "completed", observations: [{ controllerId: "screen" }] });
    expect(f.events.find(event => event.type === "execution")?.trace.epoch).toBeUndefined();
    for (const argv of [["controller/pad.echo", "--args", '{"label":"manual"}'], ["python/scripts/actions.py:echo"]]) {
      const denied = await f.cli(argv);
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("STALE_EPOCH");
    }
    expect(f.actions).toHaveLength(0);
    expect(await Bun.file(join(f.workspace, "imported")).exists()).toBe(false);

    const epoch = (await f.runtime.start()).epoch!;
    const argsFile = join(f.workspace, "arguments.json");
    await writeFile(argsFile, '{"label":"--args literal --help"}');
    const literal = await f.cli(["controller/pad.echo", "--file", argsFile], epoch);
    expect(literal.exitCode).toBe(0);
    expect(JSON.parse(literal.stdout).stdout).toBe('{"label":"--args literal --help"}');
    const combined = await f.python(`import json
from rsa_tools import Client
print(json.dumps(Client().call("python/scripts/actions.py:combined", {"label": "前进"})))`, epoch);
    expect(combined.stderr).toBe("");
    expect(combined.exitCode).toBe(0);
    expect(JSON.parse(combined.stdout)).toMatchObject({label: "v1:前进", motion: {status: "completed", stdout: '{"label":"前进"}', result: { structuredContent: {label: '前进'}, _meta: {native: true} }}});
    expect(f.actions).toEqual([{args: {label: "--args literal --help"}, epoch}, {args: {label: "前进"}, epoch}]);
    const nested = f.events.filter(event => event.type === "python_call_start");
    expect(nested).toHaveLength(2);
    expect(nested[0]!.trace).toMatchObject({traceId: f.parentTrace.traceId, parentSpanId: f.parentTrace.spanId});
    expect(nested[1]!.trace).toMatchObject({traceId: f.parentTrace.traceId, parentSpanId: nested[0]!.trace.spanId});
    expect(nested[1]!.trace.spanId).not.toBe(nested[0]!.trace.spanId);
    expect(nested[0]!.data.pid).toBe(nested[1]!.data.pid);
    for (const event of nested) {
      expect(event.metadata.source).toMatchObject({component: "workspace", implementation: "python"});
      expect(event.metadata.origin.eventId).toBeString();
      expect(f.events.filter(item => item.type === "python_call_end" && item.trace.spanId === event.trace.spanId)).toHaveLength(1);
      expect(f.events.find(item => item.type === "python_call_end" && item.trace.spanId === event.trace.spanId)?.data).toMatchObject({outcome: "success"});
    }
    expect(f.events.filter(event => event.type === "python_capability")).toHaveLength(0);
    const nestedDriver = f.events.find(event => event.type === "capability_start" && event.data.id === "controller/pad.echo"
      && event.trace.parentSpanId === nested[0]!.trace.spanId)!;
    expect(nestedDriver).toBeDefined();
    expect(f.events.find(event => event.type === "execution" && event.trace.parentSpanId === nestedDriver.trace.spanId)).toBeDefined();
    for (const event of [...nested, ...f.events.filter(event => event.type === "execution" && event.data.requiresControl)]) {
      expect(event.trace).toMatchObject({epoch, toolCallId: "integration-call", traceId: f.parentTrace.traceId});
    }
    const concurrent = await Promise.all([f.cli(["python/scripts/actions.py:echo"], epoch), f.cli(["python/scripts/actions.py:echo"], epoch)]);
    expect(concurrent.map(result => result.exitCode)).toEqual([0, 0]);
    const siblings = f.events.filter(event => event.type === "python_capability").slice(-2);
    expect(new Set(siblings.map(event => event.trace.spanId)).size).toBe(2);
    for (const event of siblings) expect(event.trace).toMatchObject({traceId: f.parentTrace.traceId, parentSpanId: f.parentTrace.spanId});

    const captured = await f.cli(["controller/screen.capture"], epoch);
    expect(captured.exitCode).toBe(0);
    const captureDisplay = JSON.parse(captured.stdout);
    const [observation] = captureDisplay.observations;
    expect(captureDisplay.result.content[0].resource).toMatchObject({uri: "fixture:///frame", blob: Buffer.from('{"visible":true}').toString("base64")});
    const apiCapture = await f.python('import json; from rsa_tools import Client; print(json.dumps(Client().call("controller/screen.capture")))', epoch);
    expect(JSON.parse(apiCapture.stdout).result).toMatchObject({ _meta: { original: true }, content: [{type: "resource", resource: {
      uri: "fixture:///frame", blob: Buffer.from('{"visible":true}').toString("base64") }}] });
    expect(observation.path).toBe(f.source);
    await rm(f.source);
    expect(await Bun.file(join(f.runDir, "observations")).exists()).toBe(false);
    expect(Buffer.from(captureDisplay.result.content[0].resource.blob, "base64").toString()).toBe('{"visible":true}');
    expect(f.events.findLast(event => event.type === "observation")).toMatchObject({data: {path: observation.path}, trace: {epoch, toolCallId: "integration-call"}});

    await writeFile(path, source.replace('"v1:"', '"v2:"'));
    const changed = await f.cli(["python/scripts/actions.py:echo"], epoch);
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout.trim()).toBe("v2:hello");
    await rm(path);
    expect(JSON.parse((await f.cli(["list"])).stdout).capabilities.map((item: any) => item.id)).toEqual(["controller/pad.echo", "controller/screen.capture"]);
    const removed = await f.cli(["python/scripts/actions.py:echo"], epoch);
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain("Unknown capability");
    expect((await f.cli(["controller/pad.echo", "--args", '{"label":"fail"}'], epoch)).exitCode).toBe(17);
    await expect(send(f.rsaSocket, {kind: "controller", argv: [], action: "call", id: "controller/pad.echo", arguments: [], epoch})).rejects.toThrow("JSON object");
    const actionsBeforeInvalid = f.actions.length;
    await expect(send(f.rsaSocket, {kind: "controller", argv: [], action: "call", id: "controller/pad.echo", arguments: {label: 3}, epoch})).rejects.toThrow("Invalid arguments");
    expect(f.actions).toHaveLength(actionsBeforeInvalid);
    const completed = f.events.filter(event => event.type === "capability_end");
    expect(completed.filter(event => event.data.outcome === "error")).toHaveLength(6);
    expect(completed.find(event => event.data.exitCode === 17)?.data).toMatchObject({outcome: "error", status: "failed"});
    for (const started of f.events.filter(event => event.type === "capability_start")) {
      expect(completed.filter(event => event.trace.spanId === started.trace.spanId)).toHaveLength(1);
    }
    for (const started of f.events.filter(event => event.type === "python_capabilities_start")) {
      expect(f.events.filter(event => event.type === "python_capabilities" && event.trace.spanId === started.trace.spanId)).toHaveLength(1);
      expect(f.events.find(event => event.type === "capability_start" && event.trace.spanId === started.trace.parentSpanId)).toBeDefined();
    }
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
        return Client().call("controller/pad.echo", {"label": "wait"})
    time.sleep(30)
    Path("unexpected-completion").touch()
`);
    const epoch = (await f.runtime.start()).epoch!;
    const raw = await disconnectable(call(epoch, "controller/pad.echo", {label: "wait"}));
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
    const stale = await f.cli(["controller/pad.echo", "--args", '{"label":"stale"}'], epoch);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("STALE_EPOCH");
    expect(f.events.find(event => event.type === "capability_end" && event.data.error?.includes("STALE_EPOCH"))?.data).toMatchObject({outcome: "error"});
    expect(f.actions).toHaveLength(2);
    expect(await send(f.rsaSocket, call(nextEpoch, "controller/pad.echo", {label: "current"}))).toMatchObject({status: "completed"});
    expect(f.actions[2]).toEqual({args: {label: "current"}, epoch: nextEpoch});
    const completed = f.events.filter(event => event.type === "capability_end");
    expect(completed.filter(event => event.data.outcome === "cancelled")).toHaveLength(4);
    for (const started of f.events.filter(event => event.type === "capability_start")) {
      expect(completed.filter(event => event.trace.spanId === started.trace.spanId)).toHaveLength(1);
    }
    for (const started of f.events.filter(event => event.type === "python_capability")) {
      expect(f.events.filter(event => event.type === "python_capability_result" && event.trace.spanId === started.trace.spanId))
        .toEqual([expect.objectContaining({data: expect.objectContaining({outcome: "cancelled"})})]);
    }
  } finally {
    for (const socket of clients) socket.destroy();
    await f.close();
  }
}, 15000);
