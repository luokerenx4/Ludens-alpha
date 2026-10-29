import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PerceptionRuntime, observationBytes, perceptionInput, perceptionMetadata, type PerceptionRead, type ObservationQuery } from "../src/harness/perception.ts";

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
  const samples = () => {
    const directory = join(workspace, ".rsa/timeline/segments");
    return readdirSync(directory).filter(name => name.endsWith(".jsonl")).sort().flatMap(name =>
      readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean).map(line => {
        const record = JSON.parse(line);
        return { data: { snapshot: record }, trace: record.trace ?? {} };
      }));
  };
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
from rsa_tools import capability, record
class Perception:
    sample_hz = ${hz}
    def start(self, context):
        self.count = 0
${start || "        pass"}
    @record
    @capability
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
    expect((await f.observe()).records).toEqual([]);
    await f.load(source('        raise NotImplementedError("Implement sample")'));
    expect((await f.observe()).error?.message).toContain("Implement sample");
    await f.load(source('        return {"media": [{"path": "missing.png", "mediaType": "image/png"}]}'));
    expect(f.runtime.status().state).toBe("error");
    await f.load(source('        return {"text": "fixed"}'));
    expect((await f.observe()).records[0]!.text).toBe("fixed");
    await f.runtime.stop();
    expect((await f.observe()).error?.code).toBe("UNAVAILABLE");
    expect(f.runtime.status().state).toBe("stopped");
    expect(f.events.filter(e => e.type === "perception_observe_end").every(e => e.data.queryId === e.trace.spanId)).toBe(true);
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
    const file = delivered.records[0]!.media[0]!;
    expect((await observationBytes(file)).toString("utf8")).toBe(delivered.records[0]!.text);
    const first = delivered.records[0]!;
    await f.wait(() => Number(readFileSync(join(f.workspace, "frame.txt"), "utf8")) >= 8);
    const expired = await f.observe({ at: first.recordedAt });
    expect(expired.error?.code).toBe("EXPIRED");
    expect(expired.error?.message).toContain("expired");
    expect(expired.availability?.expired).toBe(true);
    expect(expired.availability?.earliest?.sequence).toBeGreaterThan(first.sequence);
    expect((await f.observe({ id: "never-existed" })).error?.code).toBe("NOT_FOUND");
    expect((await f.observe({ capability: "python/missing.py:sample" })).error?.code).toBe("NOT_READY");
    expect((await observationBytes(file)).toString("utf8")).toBe(delivered.records[0]!.text);
    const reads = await Promise.all([f.observe(), f.observe(), f.observe()]);
    for (const read of reads) {
      expect(read.error).toBeUndefined();
      expect((await observationBytes(read.records[0]!.media[0]!)).toString("utf8")).toBe(read.records[0]!.text);
    }
  } finally { await f.cleanup(); }
});

test("cold history remains queryable across segments and worker reload", async () => {
  const f = await fixture({ env: { RSA_PERCEPTION_HOT_SECONDS: "0.1", RSA_PERCEPTION_SEGMENT_SECONDS: "0.15" } });
  try {
    const code = source('        self.count += 1\n        return {"text": str(self.count)}');
    await f.load(code);
    const first = (await f.observe()).records[0]!;
    await f.wait(() => f.samples().length >= 8);
    expect((await f.observe({ at: first.recordedAt })).records[0]?.id).toBe(first.id);
    await f.load(code);
    const cold = await f.observe({ at: first.recordedAt });
    expect(cold.records[0]?.id).toBe(first.id);
    expect(cold.availability?.persistent).toBe(true);
    expect(cold.availability?.expired).toBe(false);
  } finally { await f.cleanup(); }
});

test("budget eviction status updates without observe calls and resets on reload", async () => {
  const f = await fixture({ env: { RSA_PERCEPTION_PERSIST: "0", RSA_PERCEPTION_HOT_BYTES: "3500" } });
  try {
    await f.runtime.reload(); // A timeline writer exists even without a sampler.
    expect(f.runtime.status().history?.budgetEvictions).toBe(0);
    for (const [channel, size] of [["A", 1500], ["B", 3000], ["A", 1500]] as const) {
      await f.runtime.append({ sample: { text: "x".repeat(size) }, identity: { id: channel }, generation: "g",
        sampling: { clock: "test", startedAtMs: 0, finishedAtMs: 1 } }, new AbortController().signal);
    }
    expect(f.runtime.status().history?.budgetEvictions).toBeGreaterThan(0);
    expect(f.events.filter(event => event.type === "perception_observe_end")).toHaveLength(0);
    expect(f.events.filter(event => event.type === "perception_status" && event.data.history?.budgetEvictions > 0)).toHaveLength(0);
    await f.runtime.reload();
    expect(f.runtime.status().history?.budgetEvictions).toBe(0);
    await f.load(source('        return {"text": "x" * 3000}'));
    await f.wait(() => (f.runtime.status().history?.budgetEvictions ?? 0) > 0);
    expect(f.events.filter(event => event.type === "perception_observe_end")).toHaveLength(0);
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
    expect(page.records[0]!.id).toBe(first.id);
    const exact = await f.observe({ at: first.recordedAt });
    expect(exact.records[0]?.id).toBe(first.id);
    expect(exact.records[0]!.text).toBe("1");
    expect((await observationBytes(exact.records[0]!.media[0]!)).toString("utf8")).toBe("1");
    expect(exact.records[0]!.media[0]!.timing.clock).toBe(first.sampling.clock);
    const gap = new Date((Date.parse(first.recordedAt) + Date.parse(f.samples()[1]!.data.snapshot.recordedAt)) / 2).toISOString();
    expect((await f.observe({ at: gap })).records[0]?.id).toBe(first.id);
    const absent = await f.observe({ at: "2000-01-01T00:00:00Z" });
    expect(absent.records).toEqual([]);
    expect(absent.error?.code).toBe("NOT_FOUND");
    expect((await f.observe({ id: "missing-record" })).error?.code).toBe("NOT_FOUND");
    expect((await f.observe({ capability: "python/missing.py:sample" })).error?.code).toBe("NOT_READY");
    const empty = await f.observe({ start: "2000-01-01T00:00:00Z", end: "2000-01-02T00:00:00Z" });
    expect(empty).toMatchObject({ ok: true, records: [], hasMore: false });
    expect(empty.error).toBeUndefined();
    const exhausted = await f.observe({ after: 1_000_000 });
    expect(exhausted).toMatchObject({ ok: true, records: [], hasMore: false });
    const latest = await f.observe();
    expect(Number(latest.records[0]!.sequence)).toBeGreaterThanOrEqual(5);
    const same = await f.observe({ at: latest.records[0]!.recordedAt });
    expect(same.records[0]!.id).toBe(latest.records[0]!.id);
    expect(same.queryId).not.toBe(latest.queryId);
    const expanded = await f.observe({ start: first.recordedAt, end: latest.records[0]!.recordedAt });
    expect(expanded.records.length).toBeGreaterThan(1);
    const sampleEvent = f.samples()[0]!;
    expect(sampleEvent.trace.epoch).toBeUndefined();
    expect(sampleEvent.trace.modelCallId).toBeUndefined();
    const read = f.events.find(e => e.type === "perception_observe_end")!;
    expect(read.trace.parentSpanId).toBe("model-span");
    expect(read.data.queryId).toBe(read.trace.spanId);
    for (const legacy of ["result", "snapshot", "status", "reused"]) {
      expect(latest).not.toHaveProperty(legacy);
      expect(read.data).not.toHaveProperty(legacy);
    }
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
    expect(one.records[0]!.text).toBe("1");
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
    expect((await f.observe()).records[0]!.text).toBe("old:old weights");
    const fresh = await f.load(code);
    expect(fresh.pid).not.toBe(old.pid);
    expect(await readFile(join(f.workspace, "closed"), "utf8")).toBe(String(old.pid));
    expect((await f.observe()).records[0]!.text).toBe("new:new weights");
    const history = await f.observe({ at: first.records[0]!.recordedAt });
    expect(history.records[0]?.generation).toBe(old.generation!);
    expect(history.records[0]!.text).toBe("old:old weights");
    const pointWithEmptyFields = await f.observe({ at: first.records[0]!.recordedAt, start: "", end: null, after: 0 });
    expect(pointWithEmptyFields.records[0]?.id).toBe(first.records[0]!.id);
    expect(pointWithEmptyFields.query).toEqual({ at: first.records[0]!.recordedAt });
    const sources = JSON.parse(await readFile(join(f.workspace, "logs", "run", "perception", fresh.generation!, "sources.json"), "utf8"));
    expect(Object.keys(sources).sort()).toEqual(["helper.py", "perception.py"]);
    await f.load(source('        raise RuntimeError("broken sampler")'));
    const failed = await f.observe();
    expect(failed.error?.message).toContain("broken sampler");
    expect(failed.records).toEqual([]);
    const emptyLatest = await f.observe({ at: "", start: null, end: " ", limit: null, after: null });
    expect(emptyLatest.error?.message).toContain("broken sampler");
    expect(emptyLatest.records).toEqual([]);
    expect(emptyLatest.query).toEqual({});
    const retained = await f.observe({ at: first.records[0]!.recordedAt });
    expect(retained.ok).toBe(true);
    expect(retained.records[0]?.id).toBe(first.records[0]!.id);
    expect(f.runtime.status().state).toBe("error");
  } finally { await f.cleanup(); }
});

test("invalid query does not damage sampler health and stuck startup is recoverable", async () => {
  const f = await fixture({ startTimeoutMs: 200 });
  try {
    await writeFile(join(f.workspace, "perception.py"), source('        return {}', '        time.sleep(10)'));
    expect((await f.runtime.reload()).error).toContain("start timed out");
    await f.load(source('        return {"text":"ok"}'));
    expect((await f.observe({ at: "bad" })).error?.code).toBe("QUERY_FAILED");
    expect((await f.observe({ at: "2026-01-01T00:00:00Z", start: "2026-01-01T00:00:00Z" })).error).toBeDefined();
    expect(f.runtime.status().state).toBe("ready");
    expect((await f.observe()).records[0]!.text).toBe("ok");
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


test("one record carries payload once; model views preserve semantic sources without internal storage metadata", () => {
  const read: PerceptionRead = {
    queryId: "query-span", ok: true, query: {}, hasMore: false,
    records: [{ id: "record", sequence: 7, generation: "generation", capability: "python/perception.py:Perception.sample",
      identity: { id: "capability", codeSHA: "source-version", origin: { path: "perception.py" } },
      trace: { spanId: "sample-span" }, runId: "run", timeline: { recordId: "record", sequence: 7 },
      recordedAt: "2026-10-28T00:00:00.000Z", sampledAt: "2026-10-27T23:59:59.999Z",
      sampling: { clock: "sampler", startedAtMs: 100, finishedAtMs: 120 },
      text: "single semantic payload", data: { velocity: 2 }, space: { unit: "pixels" },
      sources: [{ sensor: "camera", frame: 1 }],
      media: [{ id: "record-0", controllerId: "perception", mediaType: "image/png", data: "bytes",
        timeline: { asset: "video/frame", recordId: "record", sequence: 7 },
        timing: { clock: "sampler", requestedAtMs: 100, receivedAtMs: 120 } }],
    }],
  };
  const input = perceptionInput(read);
  expect(input.records[0]).toMatchObject({ id: "record", codeSHA: "source-version",
    sources: [{ sensor: "camera", frame: 1 }], data: { velocity: 2 }, space: { unit: "pixels" },
    sampledAt: "2026-10-27T23:59:59.999Z", sampling: read.records[0]!.sampling,
    media: [{ id: "record-0", mediaType: "image/png" }] });
  for (const field of ["identity", "trace", "runId", "timeline"]) expect(input.records[0]).not.toHaveProperty(field);
  expect(JSON.stringify(input).split("single semantic payload")).toHaveLength(2);
  const logged = perceptionMetadata(read);
  expect(logged.records[0]).toHaveProperty("trace");
  expect(logged.records[0]).not.toHaveProperty("data");
  expect(logged.records[0]).not.toHaveProperty("space");
  expect(logged.records[0]!.media[0]).not.toHaveProperty("data");
  expect(read.records[0]!.media[0]!.data).toBe("bytes");
});
