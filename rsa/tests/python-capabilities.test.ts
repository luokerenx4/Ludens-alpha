import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonCapabilities } from "../src/harness/python-capabilities.ts";
import { BasewareCore } from "@playness/baseware/core";
import { BasewareClient } from "@playness/baseware/client";
import { listen } from "@playness/baseware/server";
import { captureResult } from "./runtime-fixture.ts";

async function workspace() { return realpath(await mkdtemp(join(tmpdir(), "rsa-python-"))); }

test("discovery reads decorated signatures without importing workspace files", async () => {
  const directory = await workspace();
  try {
    await mkdir(join(directory, "tools"));
    await mkdir(join(directory, "logs"));
    await writeFile(join(directory, "helper.py"), "raise RuntimeError('do not import helpers during discovery')\n");
    const source = `from __future__ import annotations
from rsa_tools import capability
from pathlib import Path
Path("imported").touch()
@capability()
def move(direction: str, steps: int = 2, payload: dict[str, list[float]] | None = None, *, enabled: bool = True):
    """Move in a direction for a bounded number of steps."""
    return direction
@capability
async def waiting(value: str):
    """Unsupported async function."""
@capability
def unsupported(value: tuple):
    """Unsupported tuple parameter."""
@capability
def missing_type(value):
    """Requires annotation."""
@capability
def dynamic_default(value: int = int("2")):
    """Requires a literal default."""
`;
    await writeFile(join(directory, "tools", "actions.py"), source);
    await writeFile(join(directory, "logs", "ignored.py"), source);
    const registry = new PythonCapabilities(directory);
    const found = await registry.discover();
    expect(found.capabilities).toHaveLength(1);
    expect(found.capabilities[0]).toMatchObject({ description: "Move in a direction for a bounded number of steps.",
      origin: {path: "tools/actions.py", function: "move"}, parameters: {type: "object", required: ["direction"], additionalProperties: false,
        properties: {steps: {type: "integer", default: 2}, enabled: {type: "boolean", default: true},
          payload: {anyOf: [{type: "object", additionalProperties: {type: "array", items: {type: "number"}}}, {type: "null"}], default: null}}} });
    expect(found.capabilities[0]!.name).toMatch(/^python_[A-Za-z0-9_]+$/);
    expect(found.capabilities[0]!.name.length).toBeLessThanOrEqual(64);
    expect(found.diagnostics).toHaveLength(4);
    expect(found.diagnostics.map(d => d.message).join("\n")).toContain("Async capabilities are unsupported");
    expect(await Bun.file(join(directory, "imported")).exists()).toBe(false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("aliased capability decorators discover ordinary functions without importing them", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "observe.py"), `from rsa_tools import capability as cap
import rsa_tools as rsa
from pathlib import Path
Path("imported").touch()
@cap
def inspect() -> dict:
    """Provide this workspace's current observation."""
    return {"text": "view", "media": []}
@rsa.capability
def plain():
    """An ordinary callable capability."""
    return True
@cap()
def empty():
    """A capability with empty decorator arguments."""
    return True
`);
    const registry = new PythonCapabilities(directory);
    const found = await registry.discover();
    expect(found.diagnostics).toEqual([]);
    const observer = found.capabilities.find(item => item.origin.function === "inspect")!;
    expect(observer).toMatchObject({parameters: {properties: {}, required: []}});
    expect(found.capabilities).toHaveLength(3);
    expect(await Bun.file(join(directory, "imported")).exists()).toBe(false);
    const result = await registry.invoke(observer.id, {});
    expect(result).toMatchObject({isError: false, details: {codeSHA: observer.codeSHA, result: {text: "view", media: []}}});
    expect(await Bun.file(join(directory, "imported")).exists()).toBe(true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("capability decorator arguments are rejected without executing them", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "invalid.py"), `from rsa_tools import capability
raise RuntimeError("discovery must not evaluate this module")
@capability(extra=True)
def unsupported():
    """Unknown decorator argument."""
@capability(select_option())
def dynamic():
    """Do not evaluate decorator arguments during discovery."""
`);
    const found = await new PythonCapabilities(directory).discover();
    expect(found.capabilities).toEqual([]);
    expect(found.diagnostics.map(item => item.function)).toEqual(["unsupported", "dynamic"]);
    expect(found.diagnostics.every(item => item.message.includes("without decorator arguments"))).toBe(true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("invocation validates before import, loads local helpers, and refreshes edited functions", async () => {
  const directory = await workspace();
  try {
    await mkdir(join(directory, "tools"));
    const helperPath = join(directory, "tools", "helper.py");
    await writeFile(helperPath, "def increment(value):\n    return value + 1\n");
    const helperStat = await stat(helperPath);
    const compile = Bun.spawn(["python3", "-m", "py_compile", helperPath], {stdout: "ignore", stderr: "pipe"});
    expect(await compile.exited).toBe(0);
    const path = join(directory, "tools", "actions.py");
    const source = `from rsa_tools import capability
from helper import increment
from pathlib import Path
import subprocess, sys
Path("imported").touch()
@capability
def add(value: int, enabled: bool = True):
    """Increment a value using a local helper."""
    print("incidental output")
    subprocess.run([sys.executable, "-c", "print('child output')"], check=True)
    return increment(value) if enabled else value
`;
    await writeFile(path, source);
    const registry = new PythonCapabilities(directory);
    const {capabilities: [first]} = await registry.discover();
    await expect(registry.invoke("unknown", {})).rejects.toThrow("Unknown Python capability");
    const invalid = await registry.invoke(first!.id, {value: true});
    expect(invalid).toMatchObject({isError: true, details: {error: {type: "ValueError"}}});
    expect(await Bun.file(join(directory, "imported")).exists()).toBe(false);
    const unknown = await registry.invoke(first!.id, {value: 4, arbitrary: "input"});
    expect(unknown.details.error?.message).toContain("not a declared parameter");
    const called = await registry.invoke(first!.id, {value: 4});
    expect(called).toMatchObject({isError: false, content: [{type: "text", text: "5"}], details: {result: 5, codeSHA: first!.codeSHA}});
    expect(called.details.stderr).toContain("incidental output");
    expect(called.details.stderr).toContain("child output");
    await writeFile(path, source.replace("return increment(value)", "return 10 + increment(value)"));
    expect((await registry.invoke(first!.id, {value: 4})).details.error?.message).toContain("changed after discovery");
    const {capabilities: [updated]} = await registry.discover();
    expect(updated!.id).toBe(first!.id);
    expect(updated!.codeSHA).not.toBe(first!.codeSHA);
    expect((await registry.invoke(updated!.id, {value: 4})).details.result).toBe(15);
    // Timestamp-based pyc can otherwise hide same-size edits made in one second.
    await writeFile(helperPath, "def increment(value):\n    return value + 2\n");
    await utimes(helperPath, helperStat.atime, helperStat.mtime);
    await registry.discover();
    expect((await registry.invoke(updated!.id, {value: 4})).details.result).toBe(16);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("workspace capabilities use the Baseware Python client with the caller's epoch and trace", async () => {
  const directory = await workspace();
  // Keep the Unix socket path short on macOS, where /var/folders temp paths are long.
  const socketPath = `/tmp/rsa-py-${crypto.randomUUID()}.sock`;
  const requests: any[] = [];
  let connections = 0;
  const server = createServer(socket => {
    connections++;
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const envelope = JSON.parse(buffer.slice(0, end));
      requests.push(envelope.request);
      if (envelope.request.id === "disconnect") { socket.end(); return; }
      socket.write(JSON.stringify({event: {kind: "status"}}) + "\n");
      socket.write(JSON.stringify({id: envelope.id, ok: true, value: {kind: envelope.request.kind}}) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    await writeFile(join(directory, "actions.py"), `from rsa_tools import capability
from baseware import Client
@capability
def inspect(button: str):
    """Read service metadata and execute one controller command."""
    client = Client()
    return [client.status(), client.list(), client.help("pad"), client.controller("camera", {}), client.controller(button, {"key": "A"}), client.release(), client.revoke()]
`);
    const registry = new PythonCapabilities(directory);
    const {capabilities: [capability]} = await registry.discover();
    const env = {BASEWARE_SOCKET: socketPath, BASEWARE_EPOCH: "current-epoch", BASEWARE_TRACE: JSON.stringify({toolCallId: "call-1"})};
    const result = await registry.invoke(capability!.id, {button: "pad"}, {env});
    expect(result.isError).toBe(false);
    expect(requests.map(request => request.kind)).toEqual(["status", "list", "help", "controller", "controller", "release", "revoke"]);
    expect(connections).toBe(7);
    for (const request of requests) expect(request).toMatchObject({epoch: "current-epoch", trace: {toolCallId: "call-1"}});
    expect(requests[4]).toMatchObject({id: "pad", arguments: {key: "A"}});
    const disconnected = await registry.invoke(capability!.id, {button: "disconnect"}, {env});
    expect(disconnected).toMatchObject({isError: true, details: {error: {type: "ConnectionError"}}});
    expect(requests.filter(request => request.id === "disconnect")).toHaveLength(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
    await rm(socketPath, {force: true});
  }
});

test("aborting invocation kills its Python process group, including child processes", async () => {
  const directory = await workspace();
  const events: {type: string; data: any; trace: any}[] = [];
  try {
    await writeFile(join(directory, "actions.py"), `from rsa_tools import capability
import subprocess, sys, time
from pathlib import Path
@capability
def wait():
    """Wait while a child process also runs."""
    child = subprocess.Popen([sys.executable, "-c", "import time; from pathlib import Path; Path('ready').touch(); time.sleep(0.7); Path('survived').touch()"])
    time.sleep(30)
`);
    const registry = new PythonCapabilities(directory, undefined, (type, data, trace) => events.push({type, data, trace}));
    const {capabilities: [capability]} = await registry.discover();
    const controller = new AbortController();
    const running = registry.invoke(capability!.id, {}, {signal: controller.signal});
    void running.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(directory, "ready")).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(join(directory, "ready")).exists()).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow();
    await Bun.sleep(800);
    expect(await Bun.file(join(directory, "survived")).exists()).toBe(false);
    await expect(registry.invoke(capability!.id, {}, {signal: controller.signal})).rejects.toThrow();
    const started = events.filter(event => event.type === "python_capability");
    const finished = events.filter(event => event.type === "python_capability_result");
    expect(new Set(started.map(event => event.trace.spanId)).size).toBe(2);
    for (const event of started) {
      expect(finished.filter(item => item.trace.spanId === event.trace.spanId))
        .toEqual([expect.objectContaining({data: expect.objectContaining({outcome: "cancelled"})})]);
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("Python spawn failure closes discovery and invocation spans without losing function identity", async () => {
  const directory = await workspace();
  const events: {type: string; data: any; trace: any}[] = [];
  const parent = {traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef"};
  try {
    const executable = join(directory, "python");
    await writeFile(executable, "#!/bin/sh\nexec python3 \"$@\"\n");
    await chmod(executable, 0o755);
    await writeFile(join(directory, "actions.py"), 'from rsa_tools import capability\n@capability\ndef echo(value: str = "hi"):\n    """Return the supplied text."""\n    return value\n');
    const registry = new PythonCapabilities(directory, executable, (type, data, trace) => events.push({type, data, trace}));
    const {capabilities: [capability]} = await registry.discover(undefined, parent);
    await rm(executable);
    await expect(registry.invoke(capability!.id, {}, {trace: parent})).rejects.toThrow();
    await expect(registry.discover(undefined, parent)).rejects.toThrow();
    const invocation = events.find(event => event.type === "python_capability")!;
    expect(invocation.trace).toMatchObject({traceId: parent.traceId, parentSpanId: parent.spanId});
    expect(invocation.trace.spanId).not.toBe(parent.spanId);
    expect(events.find(event => event.type === "python_capability_result")).toMatchObject({
      trace: invocation.trace, data: {outcome: "error", capabilityId: capability!.id, codeSHA: capability!.codeSHA, origin: capability!.origin},
    });
    const discoveries = events.filter(event => event.type === "python_capabilities");
    expect(discoveries.map(event => event.data.outcome)).toEqual(["success", "error"]);
    expect(discoveries[1]!.trace).toMatchObject({traceId: parent.traceId, parentSpanId: parent.spanId});
    expect(discoveries[1]!.trace.spanId).not.toBe(discoveries[0]!.trace.spanId);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("Python calls the real Baseware service using the persistent owner's lease and JSON observations", async () => {
  const directory = await workspace();
  const socketPath = `/tmp/rsa-py-${crypto.randomUUID()}.sock`;
  const events: {type: string; data: any; trace: any}[] = [];
  const actions: Record<string, unknown>[] = [];
  let acquired = 0;
  const observation = {id: "sample-声", controllerId: "camera", mediaType: "application/json", path: join(directory, "sample.json"),
    timing: {clock: "test-device", requestedAtMs: 20, receivedAtMs: 21}, sourceSequence: 3};
  const core = new BasewareCore({drivers: [{id: "offline", version: "1"}],
    record: (type, data, trace) => events.push({type, data, trace}), capabilities: {
      controllers: [{tool: { name: "motor", description: "step", inputSchema: { type: "object" } }, requiresControl: true,  async acquire() { acquired++; }, async release() {},
        async execute(args, {epoch, signal}) {
          signal.throwIfAborted();
          expect(epoch).toBe("owner-epoch");
          actions.push({...args});
          return {id: "execution-1", status: "completed", exitCode: 0, stdout: "完了", stderr: "", result: { content: [{ type: "text", text: "完了" }] },
            timing: {clock: "test-device", requestedAtMs: 10, receivedAtMs: 11}};
        }}, {tool: { name: "camera", description: "capture", inputSchema: { type: "object" } }, requiresControl: false, mediaTypes: ["application/json"],
        async execute(args) { expect(args).toEqual({}); return captureResult([observation]); }}],
    }});
  const close = await listen(socketPath, core);
  const owner = await BasewareClient.connect(socketPath);
  try {
    await writeFile(observation.path, JSON.stringify({position: {x: 3, y: 4}, visible: true, label: "地图"}));
    await writeFile(join(directory, "actions.py"), `from rsa_tools import capability
from baseware import Client
import json, os
@capability
def step(label: str):
    """Execute an action and read the resulting JSON observation."""
    client = Client()
    execution = client.controller("motor", {"label": label})
    observations = client.controller("camera", {})["observations"]
    with open(observations[0]["path"], encoding="utf-8") as source:
        data = json.load(source)
    return {"execution": execution, "observations": observations, "data": data,
            "rsa_context": [os.environ.get(name) for name in ("RSA_SOCKET", "RSA_EPOCH", "RSA_TRACE")]}
`);
    await owner.request({kind: "acquire", epoch: "owner-epoch", seconds: 30});
    const registry = new PythonCapabilities(directory);
    const {capabilities: [capability]} = await registry.discover();
    const env = {BASEWARE_SOCKET: socketPath, BASEWARE_EPOCH: "owner-epoch", BASEWARE_TRACE: JSON.stringify({toolCallId: "python-real-call"}),
      RSA_SOCKET: "/tmp/current-rsa.sock", RSA_EPOCH: "obsolete", RSA_TRACE: "{}"};
    const result = await registry.invoke(capability!.id, {label: "前进"}, {env});
    expect(result).toMatchObject({isError: false, details: {result: {
      execution: {status: "completed", stdout: "完了"}, observations: [observation],
      data: {position: {x: 3, y: 4}, visible: true, label: "地图"}, rsa_context: ["/tmp/current-rsa.sock", null, null],
    }}});
    expect(actions).toEqual([{label: "前进"}]);
    expect(acquired).toBe(1);
    expect(core.status()).toMatchObject({mode: "auto", epoch: "owner-epoch"});
    expect(events.filter(event => event.type === "execution" || event.type === "observation").map(event => event.trace))
      .toEqual([...Array.from({length: 3}, () => expect.objectContaining({epoch: "owner-epoch", toolCallId: "python-real-call"}))]);
    expect(events.find(event => event.type === "observation")?.data.afterExecution).toMatchObject({id: "execution-1", captureRequestedAfterMs: 9});
    const stale = await registry.invoke(capability!.id, {label: "invalid"}, {env: {...env, BASEWARE_EPOCH: "stale-epoch"}});
    expect(stale).toMatchObject({isError: true, details: {error: {type: "BasewareError"}}});
    expect(stale.details.error?.message).toContain("STALE_EPOCH");
    expect(actions).toHaveLength(1);
  } finally {
    owner.close(); await close(); await rm(directory, {recursive: true, force: true});
  }
});
