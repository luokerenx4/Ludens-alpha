import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PerceptionRuntime, observationBytes, type ObservationQuery } from "../src/harness/perception.ts";

async function fixture(options: { startTimeoutMs?: number; observeTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-perception-")));
  const events: { type: string; data: any; trace: any }[] = [];
  const runtime = new PerceptionRuntime({ workspace, runDir: join(workspace, "logs", "run"),
    env: { BASEWARE_EPOCH: "must-not-leak" }, ...options,
    record: (type, data, trace) => events.push({ type, data, trace }),
  });
  const observe = (query: ObservationQuery = {}) => runtime.observe(new AbortController().signal,
    { traceId: "model-trace", spanId: "model-span", epoch: "must-not-leak-either" }, query);
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  };
  const samples = () => events.filter(e => e.type === "perception_sample");
  return { workspace, runtime, events, observe, wait, samples,
    load: async (code: string) => {
      await writeFile(join(workspace, "perception.py"), code);
      const status = await runtime.reload({ epoch: "reload-epoch", modelCallId: "reload-call" });
      await wait(() => runtime.status().state !== "loading");
      return status;
    },
    cleanup: async () => { await runtime.stop(); await rm(workspace, { recursive: true, force: true }); } };
}

function source(body: string, start = "", close = "", hz = 20) {
  return `from pathlib import Path
import os, time
from rsa_tools._context import current
from rsa_tools import perception, record
class Perception:
    sample_hz = ${hz}
    def start(self, context):
        self.count = 0
${start || "        pass"}
    @record
    @perception
    def sample(self):
${body}
    def close(self):
${close || "        pass"}
`;
}

test("empty implementation stays blind; sampler failure can be repaired without a raw-image fallback", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.reload()).state).toBe("unimplemented");
    expect((await f.observe()).result.observations).toEqual([]);
    await f.load(source('        raise NotImplementedError("Implement sample")'));
    expect((await f.observe()).error).toContain("Implement sample");
    await f.load(source('        return {"media": [{"path": "missing.png", "mediaType": "image/png"}]}'));
    expect(f.runtime.status().state).toBe("error");
    await f.load(source('        return {"text": "fixed"}'));
    expect((await f.observe()).result.stdout).toBe("fixed");
    await f.runtime.stop();
    expect((await f.observe()).status.state).toBe("stopped");
    expect(f.events.filter(e => e.type === "perception_observe_end").every(e => e.data.result.id)).toBe(true);
  } finally { await f.cleanup(); }
});

test("retention policy reaches the worker and expired history cannot invalidate delivered media", async () => {
  const f = await fixture({ env: { RSA_PERCEPTION_PERSIST: "0", RSA_PERCEPTION_HOT_SECONDS: "0.15" } });
  try {
    await f.load(source(`        self.count += 1
        Path("frame.txt").write_text(str(self.count))
        return {"text": str(self.count), "media": [{"path": "frame.txt", "mediaType": "text/plain"}]}`));
    expect(f.runtime.status().history?.persistent).toBe(false);
    expect(f.runtime.status().history?.hotSeconds).toBe(0.15);
    const delivered = await f.observe();
    const file = delivered.result.observations![0]!;
    expect((await observationBytes(file)).toString("utf8")).toBe(delivered.result.stdout);
    const first = delivered.snapshot!;
    await f.wait(() => f.samples().length >= 8);
    const expired = await f.observe({ at: first.recordedAt });
    expect(expired.error).toContain("expired");
    expect(expired.availability?.expired).toBe(true);
    expect(expired.availability?.earliest?.sequence).toBeGreaterThan(first.sequence);
    expect((await observationBytes(file)).toString("utf8")).toBe(delivered.result.stdout);
    const reads = await Promise.all([f.observe(), f.observe(), f.observe()]);
    for (const read of reads) {
      expect(read.error).toBeUndefined();
      expect((await observationBytes(read.result.observations![0]!)).toString("utf8")).toBe(read.result.stdout);
    }
  } finally { await f.cleanup(); }
});

test("cold history remains queryable across segments and worker reload", async () => {
  const f = await fixture({ env: { RSA_PERCEPTION_HOT_SECONDS: "0.1", RSA_PERCEPTION_SEGMENT_SECONDS: "0.15" } });
  try {
    const code = source('        self.count += 1\n        return {"text": str(self.count)}');
    await f.load(code);
    const first = (await f.observe()).snapshot!;
    await f.wait(() => f.samples().length >= 8);
    expect((await f.observe({ at: first.recordedAt })).snapshot?.id).toBe(first.id);
    await f.load(code);
    const cold = await f.observe({ at: first.recordedAt });
    expect(cold.snapshot?.id).toBe(first.id);
    expect(cold.availability?.persistent).toBe(true);
    expect(cold.availability?.expired).toBe(false);
  } finally { await f.cleanup(); }
});

test("sampling continues without reads, archives overwritten files, and queries paginated time history", async () => {
  const f = await fixture();
  try {
    await f.load(source(`        self.count += 1
        assert current()["epoch"] is None
        assert "epoch" not in current()["trace"]
        Path("frame.txt").write_text(str(self.count))
        return {"text": str(self.count), "media": [{"path":"frame.txt","mediaType":"text/plain"}]}`));
    await f.wait(() => f.samples().length >= 5);
    expect(f.events.filter(e => e.type === "perception_observe_end")).toHaveLength(0);
    const first = f.samples()[0]!.data.snapshot, fifth = f.samples()[4]!.data.snapshot;
    const page = await f.observe({ start: first.recordedAt, end: fifth.recordedAt, limit: 2 });
    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const second = await f.observe({ start: first.recordedAt, end: fifth.recordedAt, after: page.nextAfter, limit: 8 });
    expect(second.records).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    expect(page.records![0]!.snapshot.id).toBe(first.id);
    const exact = await f.observe({ at: first.recordedAt });
    expect(exact.snapshot?.id).toBe(first.id);
    expect(exact.result.stdout).toBe("1");
    expect((await observationBytes(exact.result.observations![0]!)).toString("utf8")).toBe("1");
    expect(exact.result.observations![0]!.timing.clock).toBe(first.sampling.clock);
    const gap = new Date((Date.parse(first.recordedAt) + Date.parse(f.samples()[1]!.data.snapshot.recordedAt)) / 2).toISOString();
    expect((await f.observe({ at: gap })).snapshot?.id).toBe(first.id);
    expect((await f.observe({ at: "2000-01-01T00:00:00Z" })).records).toEqual([]);
    const latest = await f.observe();
    expect(Number(latest.snapshot!.sequence)).toBeGreaterThanOrEqual(5);
    expect((await f.observe({ at: latest.snapshot!.recordedAt })).reused).toBe(true);
    const expanded = await f.observe({ start: first.recordedAt, end: latest.snapshot!.recordedAt });
    expect(expanded.reused).toBe(false);
    const sampleEvent = f.samples()[0]!;
    expect(sampleEvent.trace.epoch).toBeUndefined();
    expect(sampleEvent.trace.modelCallId).toBeUndefined();
    const read = f.events.find(e => e.type === "perception_observe_end")!;
    expect(read.trace.parentSpanId).toBe("model-span");
  } finally { await f.cleanup(); }
});

test("slow sampling never blocks reads or overlaps; cancelling a read leaves recording alive", async () => {
  const f = await fixture();
  try {
    await f.load(source(`        self.count += 1
        if self.count > 1:
            Path("sampling").write_text("1")
            time.sleep(0.5)
        return {"text": str(self.count)}`));
    await f.wait(() => f.samples().length === 1);
    await f.wait(() => Bun.file(join(f.workspace, "sampling")).size > 0);
    const began = performance.now();
    const one = await f.observe();
    expect(one.result.stdout).toBe("1");
    expect(performance.now() - began).toBeLessThan(250);
    const abort = new AbortController(); abort.abort(new Error("human takeover"));
    await expect(f.runtime.observe(abort.signal)).rejects.toThrow("human takeover");
    await f.wait(() => f.samples().length >= 3);
    const snapshots = f.samples().map(e => e.data.snapshot);
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i].sampling.startedAtMs).toBeGreaterThanOrEqual(snapshots[i - 1].sampling.finishedAtMs);
    }
    expect(f.runtime.status().state).toBe("ready");
  } finally { await f.cleanup(); }
});

test("reload replaces code and loaded assets, closes the old process, and preserves historical generations", async () => {
  const f = await fixture();
  try {
    const helper = join(f.workspace, "helper.py"), stamp = new Date("2026-01-01T00:00:00Z");
    await writeFile(helper, 'VALUE = "old"\n'); await utimes(helper, stamp, stamp);
    await writeFile(join(f.workspace, "weights.txt"), "old weights");
    const code = source('        return {"text": self.value}',
      '        import helper\n        self.value = helper.VALUE + ":" + Path("weights.txt").read_text()',
      '        Path("closed").write_text(str(os.getpid()))');
    const old = await f.load(code);
    const first = await f.observe();
    await writeFile(helper, 'VALUE = "new"\n'); await utimes(helper, stamp, stamp);
    await writeFile(join(f.workspace, "weights.txt"), "new weights");
    expect((await f.observe()).result.stdout).toBe("old:old weights");
    const fresh = await f.load(code);
    expect(fresh.pid).not.toBe(old.pid);
    expect(await readFile(join(f.workspace, "closed"), "utf8")).toBe(String(old.pid));
    expect((await f.observe()).result.stdout).toBe("new:new weights");
    const history = await f.observe({ at: first.snapshot!.recordedAt });
    expect(history.snapshot?.generation).toBe(old.generation!);
    expect(history.result.stdout).toBe("old:old weights");
    const pointWithEmptyFields = await f.observe({ at: first.snapshot!.recordedAt, start: "", end: null, after: 0 });
    expect(pointWithEmptyFields.snapshot?.id).toBe(first.snapshot!.id);
    expect(pointWithEmptyFields.query).toEqual({ at: first.snapshot!.recordedAt });
    const sources = JSON.parse(await readFile(join(f.workspace, "logs", "run", "perception", fresh.generation!, "sources.json"), "utf8"));
    expect(Object.keys(sources).sort()).toEqual(["helper.py", "perception.py"]);
    await f.load(source('        raise RuntimeError("broken sampler")'));
    const failed = await f.observe();
    expect(failed.error).toContain("broken sampler");
    expect(failed.result.observations).toEqual([]);
    const emptyLatest = await f.observe({ at: "", start: null, end: " ", limit: null, after: null });
    expect(emptyLatest.error).toContain("broken sampler");
    expect(emptyLatest.records).toEqual([]);
    expect(emptyLatest.query).toEqual({});
    expect((await f.observe({ at: first.snapshot!.recordedAt })).snapshot?.id).toBe(first.snapshot!.id);
  } finally { await f.cleanup(); }
});

test("invalid query does not damage sampler health and stuck startup is recoverable", async () => {
  const f = await fixture({ startTimeoutMs: 200 });
  try {
    await writeFile(join(f.workspace, "perception.py"), source('        return {}', '        time.sleep(10)'));
    expect((await f.runtime.reload()).error).toContain("start timed out");
    await f.load(source('        return {"text":"ok"}'));
    expect((await f.observe({ at: "bad" })).error).toBeDefined();
    expect((await f.observe({ at: "2026-01-01T00:00:00Z", start: "2026-01-01T00:00:00Z" })).error).toBeDefined();
    expect(f.runtime.status().state).toBe("ready");
    expect((await f.observe()).result.stdout).toBe("ok");
  } finally { await f.cleanup(); }
});

test("host exit closes the detached recorder and invokes workspace close", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "perception.py"), source('        return {}', "", '        Path("closed").write_text(str(os.getpid()))'));
    const host = join(f.workspace, "host.ts");
    await writeFile(host, `import { PerceptionRuntime } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/perception.ts"))};
const runtime = new PerceptionRuntime({workspace:${JSON.stringify(f.workspace)},runDir:${JSON.stringify(join(f.workspace, "logs", "run"))},record(){}});
console.log(JSON.stringify(await runtime.reload())); process.exit(0);`);
    const launched = Bun.spawn(["bun", host], { stdout: "pipe", stderr: "pipe" });
    const status = JSON.parse(await new Response(launched.stdout).text());
    expect(await launched.exited).toBe(0);
    let closed = "";
    for (let i = 0; i < 200 && !closed; i++) {
      closed = await readFile(join(f.workspace, "closed"), "utf8").catch(() => "");
      if (!closed) await Bun.sleep(10);
    }
    expect(closed).toBe(String(status.pid));
  } finally { await f.cleanup(); }
});
