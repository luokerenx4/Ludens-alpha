import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { PerceptionRuntime } from "../src/harness/perception.ts";

async function fixture(options: { startTimeoutMs?: number; observeTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const { env, ...timeouts } = options;
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-perception-")));
  const events: { type: string; data: any; trace: any }[] = [];
  const runtime = new PerceptionRuntime({
    workspace, runDir: join(workspace, "logs", "run"), env: { BASEWARE_EPOCH: "must-not-leak", ...env },
    ...timeouts,
    record: (type, data, trace) => events.push({ type, data, trace }),
  });
  const observe = () => runtime.observe(new AbortController().signal, {
    traceId: "model-trace", spanId: "model-span", epoch: "must-not-leak-either",
  });
  return { workspace, runtime, events, observe,
    cleanup: async () => { await runtime.stop(); await rm(workspace, { recursive: true, force: true }); } };
}

function source(body: string, start = "", close = "") {
  return `from pathlib import Path
import os
from rsa_tools._context import current
class Perception:
    def start(self, context):
        self.count = 0
${start || "        pass"}
    def observe(self):
${body}
    def close(self):
${close || "        pass"}
`;
}

test("empty perception stays blind, and read errors always have an execution record", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.reload()).state).toBe("unimplemented");
    const missing = await f.observe();
    expect(missing.result.observations).toEqual([]);
    expect(missing.result.id).toBeString();
    await writeFile(join(f.workspace, "perception.py"), source('        raise NotImplementedError("Build your own perception.")'));
    await f.runtime.reload();
    const stub = await f.observe();
    expect(stub.status.state).toBe("unimplemented");
    expect(stub.error).toContain("Build your own perception");
    expect(stub.result.observations).toEqual([]);
    await f.runtime.stop();
    expect((await f.observe()).status.state).toBe("stopped");
    expect(f.events.filter(event => event.type === "perception_observe_end").every(event => event.data.result.id)).toBe(true);
  } finally { await f.cleanup(); }
});

test("initial and background driver reads attach to their generation root without inheriting the reload epoch", async () => {
  const socket = `/tmp/rsa-perception-context-${crypto.randomUUID()}.sock`;
  const received = Promise.withResolvers<any[]>(), requests: any[] = [];
  const server = createServer(connection => {
    let data = "";
    connection.on("data", chunk => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      requests.push(JSON.parse(data.slice(0, data.indexOf("\n"))));
      if (requests.length === 2) received.resolve(requests);
      connection.end(JSON.stringify({ ok: true, value: { status: "completed", observations: [] } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const f = await fixture({ env: { RSA_SOCKET: socket } });
  try {
    await writeFile(join(f.workspace, "perception.py"), source(
      '        return {"sequence": 1}',
      '        import threading\n        from rsa_tools import Client\n        Client().call("controller/camera", ["initial"])\n        threading.Thread(target=lambda: Client().call("controller/camera", ["sample"]), daemon=True).start()',
    ));
    const status = await f.runtime.reload({ epoch: "reload-epoch", modelCallId: "reload-model", traceId: "reload-parent" });
    for (const request of await received.promise) {
      expect(request.id).toBe("controller/camera");
      expect(request.epoch).toBeUndefined();
      expect(request.trace.epoch).toBeUndefined();
      expect(request.trace.modelCallId).toBeUndefined();
      const root = f.events.find(event => event.type === "perception_status"
        && event.trace?.traceId === request.trace.traceId && event.trace?.spanId === request.trace.spanId);
      expect(root?.data.generation).toBe(status.generation);
    }
  } finally {
    await f.cleanup();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(socket, { force: true });
  }
});

test("calls retain process memory and archive each published sequence once", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "frame.txt"), "first frame");
    await writeFile(join(f.workspace, "perception.py"), source(`        self.count += 1
        assert current()["epoch"] is None
        assert "epoch" not in current()["trace"]
        return {"sequence": 7, "text": str(self.count), "media": [{"path": "frame.txt", "mediaType": "text/plain"}]}`));
    await f.runtime.reload();
    const pid = f.runtime.status().pid;
    const [first, concurrent] = await Promise.all([f.observe(), f.observe()]);
    expect(concurrent!.snapshot).toEqual(first!.snapshot);
    await writeFile(join(f.workspace, "frame.txt"), "source overwritten");
    const second = await f.observe();
    expect(f.runtime.status().pid).toBe(pid);
    expect(second.reused).toBe(true);
    expect(second.snapshot).toEqual(first!.snapshot);
    expect(second.snapshot?.sampledAt).toBeUndefined();
    expect(second.result.id).not.toBe(first!.result.id);
    expect(second.result.observations).toEqual(first!.result.observations);
    expect(second.result.stdout).toBe("1");
    expect(await readFile(second.result.observations![0]!.path, "utf8")).toBe("first frame");
    const reads = f.events.filter(event => event.type === "perception_observe_end");
    expect(reads[0]!.trace.spanId).not.toBe(reads[1]!.trace.spanId);
    expect(reads[0]!.trace.parentSpanId).toBe("model-span");
  } finally { await f.cleanup(); }
});

test("host exit closes stdin and the detached perception worker runs close before exiting", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "perception.py"), source('        return {"sequence": 1}', "", '        Path("closed").write_text(str(os.getpid()))'));
    const host = join(f.workspace, "host.ts");
    await writeFile(host, `
import { PerceptionRuntime } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/perception.ts"))};
const runtime = new PerceptionRuntime({
  workspace: ${JSON.stringify(f.workspace)}, runDir: ${JSON.stringify(join(f.workspace, "logs", "run"))},
  record() {},
});
const status = await runtime.reload();
console.log(JSON.stringify(status));
process.exit(status.state === "ready" ? 0 : 1);
`);
    const launched = Bun.spawn(["bun", host], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(launched.stdout).text();
    expect(await launched.exited).toBe(0);
    const status = JSON.parse(output);
    const deadline = Date.now() + 3000;
    let closed = "";
    while (Date.now() < deadline) {
      closed = await readFile(join(f.workspace, "closed"), "utf8").catch(() => "");
      if (closed === String(status.pid)) break;
      await Bun.sleep(10);
    }
    expect(closed).toBe(String(status.pid));
  } finally { await f.cleanup(); }
});

test("explicit reload replaces code, helper modules and model assets, and runs close", async () => {
  const f = await fixture();
  try {
    const helper = join(f.workspace, "helper.py");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await writeFile(helper, 'VALUE = "old"\n');
    await utimes(helper, timestamp, timestamp);
    await writeFile(join(f.workspace, "weights.txt"), "old weights");
    await writeFile(join(f.workspace, "perception.py"), source(
      '        return {"sequence": 1, "text": self.value}',
      '        import helper\n        self.value = helper.VALUE + ":" + Path("weights.txt").read_text()',
      '        Path("closed").write_text(str(os.getpid()))',
    ));
    const firstStatus = await f.runtime.reload();
    expect((await f.observe()).result.stdout).toBe("old:old weights");
    await writeFile(helper, 'VALUE = "new"\n');
    await utimes(helper, timestamp, timestamp);
    await writeFile(join(f.workspace, "weights.txt"), "new weights");
    expect((await f.observe()).result.stdout).toBe("old:old weights");
    const secondStatus = await f.runtime.reload();
    expect(secondStatus.generation).not.toBe(firstStatus.generation);
    expect(secondStatus.pid).not.toBe(firstStatus.pid);
    expect(await readFile(join(f.workspace, "closed"), "utf8")).toBe(String(firstStatus.pid));
    expect((await f.observe()).result.stdout).toBe("new:new weights");
    const sources = JSON.parse(await readFile(join(f.workspace, "logs", "run", "perception", secondStatus.generation!, "sources.json"), "utf8"));
    expect(Object.keys(sources).sort()).toEqual(["helper.py", "perception.py"]);
  } finally { await f.cleanup(); }
});

test("reload during an observe keeps the old response out of the new generation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "perception.py"), source(`        import time
        Path("entered").touch()
        time.sleep(10)
        return {"sequence": 1, "text": "old response"}`));
    const oldStatus = await f.runtime.reload();
    const oldRead = f.observe();
    const deadline = Date.now() + 2000;
    while (!await Bun.file(join(f.workspace, "entered")).exists() && Date.now() < deadline) await Bun.sleep(10);
    await writeFile(join(f.workspace, "perception.py"), source('        return {"sequence": 1, "text": "new response"}'));
    const newStatus = await f.runtime.reload();
    const replaced = await oldRead;
    expect(replaced.status.generation).toBe(oldStatus.generation);
    expect(replaced.error).toContain("replaced");
    expect(replaced.result.observations).toEqual([]);
    expect(f.runtime.status()).toEqual(newStatus);
    expect((await f.observe()).result.stdout).toBe("new response");
  } finally { await f.cleanup(); }
});

test("bounded calls let the agent repair a blocked implementation without losing the host", async () => {
  const f = await fixture({ startTimeoutMs: 150, observeTimeoutMs: 50 });
  try {
    await writeFile(join(f.workspace, "perception.py"), source(
      '        return {"sequence": 1}',
      '        import time\n        time.sleep(10)',
    ));
    expect((await f.runtime.reload()).error).toContain("start timed out");
    await writeFile(join(f.workspace, "perception.py"), source('        import time\n        time.sleep(10)\n        return {"sequence": 1}'));
    await f.runtime.reload();
    const pid = f.runtime.status().pid;
    expect((await f.observe()).error).toContain("observe timed out");
    expect(f.runtime.status().pid).toBe(pid);
    await writeFile(join(f.workspace, "perception.py"), source('        return {"sequence": 1, "text": "repaired"}'));
    await f.runtime.reload();
    expect((await f.observe()).result.stdout).toBe("repaired");
  } finally { await f.cleanup(); }
});

test("cancelling one wait preserves the worker and its later calls", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "perception.py"), source(`        import time
        self.count += 1
        Path("entered").touch()
        if self.count == 1:
            time.sleep(0.2)
        return {"sequence": self.count, "text": str(self.count)}`));
    await f.runtime.reload();
    const pid = f.runtime.status().pid;
    const abort = new AbortController();
    const first = f.runtime.observe(abort.signal);
    void first.catch(() => {});
    const deadline = Date.now() + 2000;
    while (!await Bun.file(join(f.workspace, "entered")).exists() && Date.now() < deadline) await Bun.sleep(10);
    abort.abort(new Error("human takeover"));
    await expect(first).rejects.toThrow("human takeover");
    const second = await f.observe();
    expect(second.result.stdout).toBe("2");
    expect(f.runtime.status().pid).toBe(pid);
    expect(f.events.filter(event => event.type === "perception_observe_end").map(event => event.data.outcome)).toEqual(["cancelled", "success"]);
  } finally { await f.cleanup(); }
});

test("failed reload and invalid snapshots are visible, and a repaired implementation can reload", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "perception.py"), "invalid Python !");
    expect((await f.runtime.reload()).state).toBe("error");
    expect((await f.observe()).error).toContain("SyntaxError");
    await writeFile(join(f.workspace, "perception.py"), source('        return {"text": "no version"}'));
    await f.runtime.reload();
    expect((await f.observe()).error).toContain("sequence");
    await writeFile(join(f.workspace, "perception.py"), source('        return {"sequence": 1, "text": "fixed"}'));
    await f.runtime.reload();
    expect((await f.observe()).result.stdout).toBe("fixed");
  } finally { await f.cleanup(); }
});
