import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";

test("Python API composes driver and workspace calls with the caller's epoch, without retrying failures", async () => {
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
          client.call("python/scripts/move.py:step", {"label": "前进", "steps": 2}),
          client.call("sensor/screen")]
errors = []
for capability_id in ["rejected", "disconnect"]:
    try:
        client.call(capability_id)
    except (RSAError, ConnectionError) as error:
        errors.append({"type": type(error).__name__, "message": str(error)})
explicit = Client(${JSON.stringify(socketPath)}, epoch="explicit-epoch", trace={"source": "explicit"}, timeout=1)
values.append(explicit.help("sensor/screen"))
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
      {action: "call", arguments: {label: "前进", steps: 2}},
      {action: "call", arguments: null}, {action: "help", arguments: null},
    ]);
    expect(result.errors).toEqual([
      {type: "RSAError", message: "STALE_EPOCH: caller no longer owns control"},
      {type: "ConnectionError", message: "RSA disconnected before replying; the request was not retried"},
    ]);
    expect(connections).toBe(8);
    expect(requests).toHaveLength(8);
    for (const request of requests.slice(0, 7)) {
      expect(request).toMatchObject({kind: "controller", argv: [], epoch: "active-epoch", trace: {toolCallId: "parent-call"}});
    }
    expect(requests[4]).not.toHaveProperty("arguments");
    expect(requests[7]).toMatchObject({action: "help", id: "sensor/screen", epoch: "explicit-epoch", trace: {source: "explicit"}});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
