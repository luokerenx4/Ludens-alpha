import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Python API calls drivers with the caller's epoch, without retrying failures", async () => {
  const socketPath = `/tmp/rsa-api-${crypto.randomUUID()}.sock`;
  const requests: any[] = [];
  let connections = 0;
  const server = createServer(socket => {
    connections++;
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      requests.push(request);
      if (request.id === "disconnect") { socket.end(); return; }
      const reply = request.id === "rejected"
        ? { ok: false, error: "STALE_EPOCH: caller no longer owns control" }
        : { ok: true, value: { action: request.action, arguments: request.arguments ?? null } };
      // Exercise line buffering and Unicode responses across socket writes.
      const line = JSON.stringify(reply) + "\n";
      socket.write(line.slice(0, 7));
      socket.end(line.slice(7));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    const child = Bun.spawn(["python3", "-B", "-c", `
import json
from rsa_tools import Client, RSAError, capability
@capability
def probe():
    return "registered"
client = Client()
values = [client.list(), client.help("controller/pad"),
          client.call("controller/pad", ["apply", "A", "100"]),
          client.call("controller/screen")]
errors = []
for capability_id in ["rejected", "disconnect"]:
    try:
        client.call(capability_id)
    except (RSAError, ConnectionError) as error:
        errors.append({"type": type(error).__name__, "message": str(error)})
explicit = Client(${JSON.stringify(socketPath)}, epoch="explicit-epoch", trace={"source": "explicit"}, timeout=1)
values.append(explicit.help("controller/screen"))
print(json.dumps({"values": values, "errors": errors, "marked": probe.__rsa_capability__}))
`], { env: { ...process.env, PYTHONPATH: join(import.meta.dir, "../python"), RSA_SOCKET: socketPath,
      BASEWARE_EPOCH: "active-epoch", BASEWARE_TRACE: JSON.stringify({toolCallId: "parent-call"}) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.marked).toBe(true);
    expect(result.values).toEqual([
      {action: "list", arguments: null}, {action: "help", arguments: null},
      {action: "call", arguments: ["apply", "A", "100"]},
      {action: "call", arguments: null}, {action: "help", arguments: null},
    ]);
    expect(result.errors).toEqual([
      {type: "RSAError", message: "STALE_EPOCH: caller no longer owns control"},
      {type: "ConnectionError", message: "RSA disconnected before replying; the request was not retried"},
    ]);
    expect(connections).toBe(7);
    expect(requests).toHaveLength(7);
    for (const request of requests.slice(0, 6)) {
      expect(request).toMatchObject({kind: "controller", argv: [], epoch: "active-epoch", trace: {toolCallId: "parent-call"}});
    }
    expect(requests[3]).not.toHaveProperty("arguments");
    expect(requests[6]).toMatchObject({action: "help", id: "controller/screen", epoch: "explicit-epoch", trace: {source: "explicit"}});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Python API and direct imports share local objects, while device calls retain the nested trace", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-local-api-")));
  const socketPath = `/tmp/rsa-api-${crypto.randomUUID()}.sock`;
  const requests: any[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      socket.end(JSON.stringify({ok: true, value: request.kind === "controller" ? {status: "completed"} : null}) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    await mkdir(join(workspace, "scripts"));
    await writeFile(join(workspace, "scripts/model.py"), `from rsa_tools import Client, capability
client = Client()
class Model:
    def __init__(self):
        self.calls = 0
model = Model()
@capability
def step(value):
    value.calls += 1
    client.call("controller/pad", ["apply", "A", "10"])
    return value
@capability
def loop(value):
    return client.call("python/scripts/model.py:step", {"value": value})
fault = ValueError("learning failed")
@capability
def fail():
    raise fault
@capability
def peek():
    return model
`);
    const parentTrace = {traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", toolCallId: "outer-exec"};
    const child = Bun.spawn(["python3", "-B", "-c", `import json, os
from rsa_tools import Client
from scripts.model import model, step, fault
first = Client().call("python/scripts/model.py:loop", {"value": model})
second = step(model)
try:
    Client().call("python/scripts/model.py:fail")
except ValueError as error:
    original_error = error is fault
offline = Client(os.environ["RSA_SOCKET"] + "-missing").call("python/scripts/model.py:peek")
print(json.dumps({"shared": first is model and second is model, "calls": model.calls,
                  "originalError": original_error, "loggingIndependent": offline is model, "pid": os.getpid()}))
`], {cwd: workspace, env: {...process.env, PYTHONPATH: join(import.meta.dir, "../python"),
      RSA_SOCKET: socketPath, RSA_WORKSPACE: workspace, RSA_RUN_ID: "local-api-run",
      BASEWARE_EPOCH: "active-epoch", BASEWARE_TRACE: JSON.stringify(parentTrace)}, stdout: "pipe", stderr: "pipe"});
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr.trim()).toMatch(/^RSA Python logging unavailable: [^\n]+$/);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({shared: true, calls: 2, originalError: true, loggingIndependent: true});
    const calls = requests.filter(request => request.kind === "controller");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatchObject({action: "call", id: "controller/pad", epoch: "active-epoch"});
    const events = requests.filter(request => request.kind === "workspace_event");
    expect(events).toHaveLength(8);
    for (const request of events) {
      expect(request).toMatchObject({runId: "local-api-run", epoch: "active-epoch", trace: {traceId: parentTrace.traceId, toolCallId: "outer-exec"}});
      expect(request.event.data.pid).toBe(result.pid);
      expect(request.event.data.codeSHA).toMatch(/^[a-f0-9]{64}$/);
      expect(request.event.data).not.toHaveProperty("arguments");
      expect(request.event.data).not.toHaveProperty("result");
    }
    const starts = events.filter(request => request.event.type === "python_call_start");
    expect(starts.map(request => request.event.data.id)).toEqual([
      "python/scripts/model.py:loop", "python/scripts/model.py:step", "python/scripts/model.py:step", "python/scripts/model.py:fail",
    ]);
    expect(starts[0].trace.parentSpanId).toBe(parentTrace.spanId);
    expect(starts[1].trace.parentSpanId).toBe(starts[0].trace.spanId);
    expect(starts[2].trace.parentSpanId).toBe(parentTrace.spanId);
    expect(calls.map(call => call.trace.spanId)).toEqual([starts[1].trace.spanId, starts[2].trace.spanId]);
    for (const start of starts) {
      const end = events.find(request => request.event.type === "python_call_end" && request.trace.spanId === start.trace.spanId);
      expect(end.event.data).toMatchObject({outcome: start.event.data.id.endsWith(":fail") ? "error" : "success"});
      expect(end.event.data.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(events.find(request => request.event.type === "python_call_end" && request.event.data.id.endsWith(":fail")).event.data.error)
      .toContain("learning failed");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(workspace, {recursive: true, force: true});
  }
});
