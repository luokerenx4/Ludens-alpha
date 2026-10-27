import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceController } from "../src/harness/controller.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen, send } from "../src/harness/transport.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";

test("local Python, Controller and CLI share a workspace timeline across runs without duplicate media", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-timeline-")));
  const socket = `/tmp/rsa-timeline-${crypto.randomUUID()}.sock`;
  const events: {type: string; data: any}[] = [];
  const record = (type: string, data: unknown) => { events.push({type, data}); };
  const {devices} = createTestDeviceSession({controllers: [{
    tool: {name: "pad.press", description: "offline input", inputSchema: {type: "object"}}, requiresControl: true,
    async execute() { throw new Error("manual input must be rejected before execution"); },
  }]}, record);
  const env = {...process.env, RSA_SOCKET: socket, RSA_WORKSPACE: workspace, RSA_RUN_ID: "first-run",
    PYTHONPATH: join(import.meta.dir, "../python"), BASEWARE_EPOCH: undefined,
    PATH: [dirname(process.execPath), join(import.meta.dir, "../bin"), process.env.PATH].join(":")};
  let runtime = new Runtime(devices, record, 60, "first-run");
  const configure = (runId: string) => {
    runtime = new Runtime(devices, record, 60, runId);
    runtime.controller = new WorkspaceController({workspace, devices, record, env: {...env, RSA_RUN_ID: runId}});
    runtime.perception = new PerceptionRuntime({workspace, runDir: join(workspace, "logs", runId),
      env: {...env, RSA_RUN_ID: runId}, record});
  };
  configure("first-run");
  const closeServer = await listen(socket, () => runtime);
  async function run(command: string[]) {
    const child = Bun.spawn(command, {cwd: workspace, env, stdout: "pipe", stderr: "pipe"});
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({exitCode, stderr}).toEqual({exitCode: 0, stderr: ""});
    return JSON.parse(stdout);
  }
  const python = (code: string) => run(["python3", "-B", "-c", code]);
  const cli = (...args: string[]) => run([join(import.meta.dir, "../bin/rsa"), ...args]);
  const blob = Buffer.from("shared offline audio").toString("base64");
  try {
    await writeFile(join(workspace, "senses.py"), `from rsa_tools import perception, record, capability, Client
import os
@perception
def transient():
    """Read the calling process without recording."""
    return {"data": {"pid": os.getpid()}, "media": [{"data": "${blob}", "mediaType": "audio/wav"}]}
@record
@perception
def temperature(value: float = 22.5):
    """Read a scalar and an audio sample."""
    return {"data": {"value": value, "pid": os.getpid()}, "space": {"frame": "room-a"},
            "sampledAt": "2026-01-01T00:00:00Z", "media": [{"data": "${blob}", "mediaType": "audio/wav"}]}
@perception
@record
def outer():
    """Compose a recorded sensing capability."""
    inner = temperature()
    return {"sources": [inner["timeline"]], "media": inner["media"], "data": {"nested": True}}
@perception
def forbidden_input():
    """Try input without a control lease."""
    return Client().call("controller/pad.press")
@capability
def action():
    """Require input control."""
    raise AssertionError("manual input must be rejected before execution")
`);
    expect((await runtime.perception!.reload()).state).toBe("unimplemented");
    const catalog = await cli("controller", "list");
    expect(catalog.capabilities.find((item: any) => item.id.endsWith(":temperature")))
      .toMatchObject({perception: true, recorded: true});
    const local = await python('import json, os; from senses import transient; print(json.dumps({"result": transient(), "pid": os.getpid()}))');
    expect(local.result.data.pid).toBe(local.pid);
    expect((await cli("controller", "python/senses.py:transient")).media[0].data).toBe(blob);
    expect(events.filter(event => event.type === "perception_sample")).toHaveLength(0);
    const results = await Promise.all([
      python('import json, os; from senses import temperature; print(json.dumps({"result": temperature(), "pid": os.getpid()}))'),
      cli("controller", "python/senses.py:temperature", "--args", '{"value":31}'),
      python('import json; from rsa_tools import Client; print(json.dumps(Client().call("python/senses.py:outer")))'),
    ]);
    const first = results[0].result;
    expect(first.data.pid).toBe(results[0].pid);
    expect(first.data.pid).not.toBe(runtime.perception!.status().pid);
    const samples = events.filter(event => event.type === "perception_sample");
    expect(samples).toHaveLength(4);
    expect(new Set(samples.map(event => event.data.snapshot.sequence)).size).toBe(4);
    expect(new Set(samples.map(event => event.data.snapshot.id)).size).toBe(4);
    expect(await readdir(join(workspace, ".rsa/timeline/objects"))).toHaveLength(1);
    expect(await readFile(first.media[0].path, "utf8")).toBe("shared offline audio");
    expect(await Bun.file(join(workspace, "logs/first-run/observations")).exists()).toBe(false);
    expect(JSON.stringify(events)).not.toContain(blob);
    const history = await cli("observe", "--id", first.timeline.recordId);
    expect(history.records[0]).toMatchObject({data: {value: 22.5}, space: {frame: "room-a"},
      snapshot: {capability: "python/senses.py:temperature", runId: "first-run", sampledAt: "2026-01-01T00:00:00Z"}});
    expect(history.result.observations[0].timeline).toEqual(first.media[0].timeline);
    expect((await cli("observe", "--capability", "python/senses.py:outer")).records[0].data.nested).toBe(true);
    // Marking perception never grants its nested action a control lease.
    await expect(send(socket, {kind: "controller", argv: [], action: "call", id: "python/senses.py:forbidden_input"}))
      .rejects.toThrow("STALE_EPOCH");
    expect(runtime.status().mode).toBe("manual");
    await runtime.close();
    configure("second-run");
    await mkdir(join(workspace, "perception.py")); // source read failure must not hide history or disable recording.
    expect((await runtime.perception!.reload()).state).toBe("error");
    const previous = await cli("observe", "--id", first.timeline.recordId);
    expect(previous.snapshot.id).toBe(first.timeline.recordId);
    expect(previous.snapshot.runId).toBe("first-run");
    const next = await cli("controller", "python/senses.py:temperature");
    expect(next.timeline.sequence).toBe(5);
    const nextRead = await cli("observe", "--id", next.timeline.recordId);
    expect(nextRead.snapshot.runId).toBe("second-run");
    expect(await readdir(join(workspace, ".rsa/timeline/objects"))).toHaveLength(1);
    expect(await Bun.file(join(workspace, "logs/second-run/observations")).exists()).toBe(false);
  } finally {
    await runtime.close();
    await closeServer();
    await rm(socket, {force: true});
    await rm(workspace, {recursive: true, force: true});
  }
}, 15000);
