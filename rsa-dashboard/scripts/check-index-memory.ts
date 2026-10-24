/**
 * Offline replay of large, existing dashboard indexes. Raw logs stay read-only.
 * node --expose-gc --max-old-space-size=1024 --import tsx scripts/check-index-memory.ts \
 *   --diagnosis /absolute/diagnosis.json --cache-root /absolute/replay --output /absolute/result.json
 */
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ActivityScope, LogBlock } from "../lib/activity";
import type { RecordPointer } from "../lib/log-index";

type Run = { path: string; eventPosition: number };
type Sample = { position: number; digest: string; at: string; type: string };
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
for (const name of ["--diagnosis", "--cache-root", "--output"])
  assert.ok(args.includes(name) && option(name), `Required: ${name}`);
const diagnosisPath = resolve(option("--diagnosis"));
const cacheRoot = resolve(option("--cache-root"));
const output = resolve(option("--output"));
const diagnosis = JSON.parse(readFileSync(diagnosisPath, "utf8")) as { runs: Run[] };
assert.ok(global.gc, "Use node --expose-gc so retained memory is measured after collection");
assert.ok(!diagnosis.runs.some(run => cacheRoot.startsWith(run.path + "/")), "Cache replay must be outside source runs");
mkdirSync(cacheRoot, { recursive: true });
mkdirSync(dirname(output), { recursive: true });

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const memory = () => ({ ...process.memoryUsage(), maxRss: process.resourceUsage().maxRSS * 1024 });
let peakHeap = 0, peakRss = 0;
const sampleMemory = () => {
  const value = memory(); peakHeap = Math.max(peakHeap, value.heapUsed); peakRss = Math.max(peakRss, value.rss);
  return value;
};
const sampling = setInterval(sampleMemory, 50);
sampling.unref();
const report: Record<string, any> = {
  startedAt: new Date().toISOString(), source: diagnosisPath, cacheRoot,
  node: process.version, execArgv: process.execArgv, before: sampleMemory(), runs: [], revisits: [],
  limitations: ["Heap peak is sampled every 50 ms; OS maxRSS also covers synchronous migration.",
    "Uses immutable historical logs and isolated cloned caches; no model or device is started."],
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const collected = () => { global.gc!(); return sampleMemory(); };
const progress = (message: string) => process.stderr.write(message + "\n");

async function* jsonLines(path: string): AsyncGenerator<Record<string, any>> {
  const input = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) if (line) yield JSON.parse(line); }
  finally { lines.close(); input.destroy(); }
}
async function readPointer<T>(pointer: RecordPointer): Promise<T> {
  const file = await open(pointer.file, "r");
  try {
    const buffer = Buffer.alloc(pointer.length);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, pointer.offset + offset);
      assert.ok(result.bytesRead, "Referenced JSONL record is complete"); offset += result.bytesRead;
    }
    return JSON.parse(buffer.toString("utf8")) as T;
  } finally { await file.close(); }
}
async function eventSamples(run: Run): Promise<Sample[]> {
  const wanted = new Set([1, Math.max(1, Math.floor(run.eventPosition / 2)), run.eventPosition]);
  const samples: Sample[] = [];
  let position = 0;
  for await (const event of jsonLines(join(run.path, "events.jsonl"))) {
    position++;
    if (wanted.has(position)) samples.push({ position, digest: sha(event), at: event.at, type: event.type });
    if (position >= run.eventPosition) break;
  }
  assert.equal(samples.length, wanted.size, "Original event samples exist");
  return samples;
}
async function activitySamples(run: Run) {
  let early: RecordPointer | undefined, text: RecordPointer | undefined, updated: RecordPointer | undefined;
  let pointers = 0, versions = 0;
  for await (const entry of jsonLines(join(run.path, ".dashboard-index/blocks/index.jsonl"))) {
    const pointer = entry as RecordPointer;
    pointers++;
    if (pointer.deleted) continue;
    if (pointer.createdRevision !== pointer.revision) versions++;
    if (!early && pointer.kind !== "diagnostic") early = pointer;
    if (!text && pointer.kind === "text") text = pointer;
    // Keep one real late-updated block's latest version, without retaining all IDs.
    if ((!updated && pointer.createdRevision < pointer.revision) || updated?.id === pointer.id) updated = pointer;
    if (early?.id === pointer.id) early = pointer;
    if (text?.id === pointer.id) text = pointer;
  }
  return { early, text, updated, pointers, versions };
}
function cloneCache(run: Run) {
  const directory = join(cacheRoot, basename(run.path));
  if (!existsSync(directory)) {
    // APFS clone duplicates metadata but shares unchanged data extents; never hardlink mutable indexes.
    execFileSync("cp", ["-cR", join(run.path, ".dashboard-index"), directory]);
  }
  return directory;
}

async function main() {
  // Configuration is set before importing the server modules.
  process.env.RSA_DASHBOARD_INDEX_ROOT = cacheRoot;
  process.env.RSA_DASHBOARD_INDEX_MAX_RUNS = "2";
  process.env.RSA_DASHBOARD_INDEX_IDLE_MS = "1000";
  process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES = String(32 * 1024 * 1024);
  const { getLogIndex, closeLogIndexes, indexCacheStats, pruneLogIndexes } = await import("../lib/log-index");
  const { queryActivity } = await import("../lib/activity");
  report.cacheConfiguration = { maxRuns: 2, idleMs: 1000, bytes: 32 * 1024 * 1024 };
  if (args.includes("--relations-only")) {
    for (const run of diagnosis.runs.slice(0, 2)) {
      cloneCache(run);
      let model: string | undefined;
      for await (const entry of jsonLines(join(run.path, ".dashboard-index/events/index.jsonl")))
        if (entry.model) { model = entry.model; break; }
      assert.ok(model, "Run has a model call to query");
      const first: { position: number; digest: string }[] = [], last: typeof first = [];
      let position = 0, count = 0;
      for await (const event of jsonLines(join(run.path, "events.jsonl"))) {
        position++;
        if (event.trace?.modelCallId !== model) continue;
        const sample = { position, digest: sha(event) }; count++;
        if (first.length < 20) first.push(sample);
        last.push(sample); if (last.length > 20) last.shift();
      }
      const index = await getLogIndex(run.path), release = index.retain();
      progress(`Building model relation index ${basename(run.path)}`);
      const started = performance.now();
      const forward = await index.queryEvents({ model, limit: 20 });
      assert.deepEqual(forward.map(row => ({ position: row.position, digest: sha(row.event) })), first);
      const reverse = await index.queryEvents({ model, limit: 20, reverse: true });
      assert.deepEqual(reverse.map(row => ({ position: row.position, digest: sha(row.event) })), last.reverse());
      release();
      report.runs.push({ runId: basename(run.path), model, matchingEvents: count,
        durationMs: performance.now() - started, afterGc: collected(), cache: indexCacheStats() });
      save();
    }
    await closeLogIndexes();
    report.afterClose = collected(); report.peakHeapSampled = peakHeap; report.peakRssSampled = peakRss;
    report.maxRss = process.resourceUsage().maxRSS * 1024;
    report.completedAt = new Date().toISOString(); report.ok = true; save();
    return;
  }
  for (const run of diagnosis.runs) {
    progress(`Preparing ${basename(run.path)}`);
    const source = statSync(join(run.path, "events.jsonl"));
    const legacy = JSON.parse(readFileSync(join(run.path, ".dashboard-index/checkpoint.json"), "utf8"));
    cloneCache(run);
    const events = await eventSamples(run), blocks = await activitySamples(run);
    const started = performance.now();
    const index = await getLogIndex(run.path);
    const release = index.retain();
    assert.notEqual(index.directory, join(run.path, ".dashboard-index"), "Uses isolated cache");
    assert.equal(index.generation, legacy.metadata.generation, "Migration preserves the generation");
    assert.equal(index.eventRevision, Number(legacy.metadata.eventPosition), "Migration preserves the event cursor");
    const result: Record<string, any> = {
      runId: basename(run.path), eventCount: index.eventRevision, sourceBytes: source.size,
      legacyPointerCount: blocks.pointers, lateVersions: blocks.versions, eventSamples: events,
      generationPreserved: true, activity: {}, memoryBeforeQueries: sampleMemory(),
    };
    const eventStarted = performance.now();
    progress(`Migrating event pointers ${basename(run.path)}`);
    for (const sample of events) {
      const page = await index.queryEvents({ afterPosition: sample.position - 1, limit: 1 });
      assert.equal(page[0]?.position, sample.position);
      assert.equal(sha(page[0].event), sample.digest, `Event ${sample.position} matches original JSONL`);
    }
    result.eventMigrationAndLookupMs = performance.now() - eventStarted;
    result.afterEventQueries = sampleMemory();
    const scope: ActivityScope = { project: "offline-memory-validation", runId: basename(run.path), epoch: null };
    const activityStarted = performance.now();
    progress(`Migrating activity pointers ${basename(run.path)}`);
    const recent = await queryActivity(index, scope, { mode: "history", limit: 20 });
    result.activityMigrationAndRecentMs = performance.now() - activityStarted;
    result.activity.recent = { ids: recent.blocks.map(block => block.id), total: "total" in recent ? recent.total : null };
    if (blocks.early) {
      const before = Buffer.from(JSON.stringify({ scope, generation: index.generation, kind: "all", q: "",
        at: new Date(Date.parse(blocks.early.at) + 1).toISOString(), id: "\uffff" })).toString("base64url");
      const early = await queryActivity(index, scope, { mode: "history", before, limit: 20 });
      assert.ok(early.blocks.some(block => block.id === blocks.early!.id), "Earliest activity remains queryable");
      result.activity.early = early.blocks.map(block => block.id);
    }
    for (const [name, pointer] of [["text", blocks.text], ["lateUpdate", blocks.updated]] as const) {
      if (!pointer) continue;
      const original = await readPointer<LogBlock>(pointer);
      const page = await queryActivity(index, scope, { mode: "block", id: pointer.id });
      assert.equal(sha(page.blocks[0]), sha(original), `${name} latest body is preserved`);
      result.activity[name] = { id: pointer.id, revision: pointer.revision, createdRevision: pointer.createdRevision, digest: sha(original) };
      if (name === "lateUpdate") {
        const cursor = Buffer.from(JSON.stringify({ scope, generation: index.generation, revision: pointer.revision - 1 })).toString("base64url");
        const delta = await queryActivity(index, scope, { cursor, limit: 1 });
        assert.equal(delta.mode, "delta");
        assert.equal(sha(delta.blocks[0]), sha(original), "Historical delta returns the real late-update version");
        result.activity.lateUpdate.deltaVerified = true;
      }
      if (name === "text" && original.text.trim()) {
        const q = original.text.trim().slice(0, 96);
        const before = Buffer.from(JSON.stringify({ scope, generation: index.generation, kind: "text", q: q.trim().toLocaleLowerCase(),
          at: new Date(Date.parse(pointer.at) + 1).toISOString(), id: "\uffff" })).toString("base64url");
        const search = await queryActivity(index, scope, { mode: "history", kind: "text", q, before, limit: 20 });
        assert.ok(search.blocks.some(block => block.id === pointer.id), "Full-history text search finds early content");
        result.activity.search = { q, total: "total" in search ? search.total : null };
      }
    }
    const after = statSync(join(run.path, "events.jsonl"));
    assert.equal(after.size, source.size); assert.equal(after.mtimeMs, source.mtimeMs);
    release();
    result.durationMs = performance.now() - started;
    result.afterGc = collected(); result.cache = indexCacheStats();
    assert.ok(result.cache.bytes <= result.cache.limit, "Decoded pointer pages stay within the cache budget");
    report.runs.push(result); save();
    progress(`Validated ${basename(run.path)}: heap ${(result.afterGc.heapUsed / 2 ** 20).toFixed(1)} MiB`);
  }
  // Reopen older runs after newer ones: eviction must not erase full-history access.
  for (let pass = 0; pass < 3; pass++) for (const run of diagnosis.runs) {
    const index = await getLogIndex(run.path);
    const release = index.retain();
    const page = await index.queryEvents({ afterPosition: Math.floor(run.eventPosition / 2) - 1, limit: 1 });
    const expected = report.runs.find((entry: any) => entry.runId === basename(run.path)).eventSamples[1];
    assert.equal(sha(page[0].event), expected.digest);
    release();
    report.revisits.push({ pass, runId: basename(run.path), afterGc: collected(), cache: indexCacheStats() });
    assert.ok(indexCacheStats().runs <= 2, "Run registry respects its configured maximum");
  }
  await pruneLogIndexes(Date.now() + 2000);
  report.afterIdleEviction = { memory: collected(), cache: indexCacheStats() };
  assert.equal(report.afterIdleEviction.cache.runs, 0, "Idle runs are evicted");
  assert.equal(report.afterIdleEviction.cache.bytes, 0, "Idle eviction releases decoded page cache");
  const firstRun = diagnosis.runs[0];
  const reopened = await getLogIndex(firstRun.path);
  const firstEvent = await reopened.queryEvents({ limit: 1 });
  assert.equal(sha(firstEvent[0].event), report.runs[0].eventSamples[0].digest, "Eviction leaves full history queryable");
  report.afterReopen = { memory: collected(), cache: indexCacheStats() };
  await closeLogIndexes();
  report.afterClose = collected(); report.peakHeapSampled = peakHeap; report.peakRssSampled = peakRss;
  report.maxRss = process.resourceUsage().maxRSS * 1024;
  report.completedAt = new Date().toISOString(); report.ok = true; save();
}
main().catch(error => {
  report.ok = false; report.error = { message: error.message, stack: error.stack }; report.failedAt = new Date().toISOString();
  report.atFailure = sampleMemory(); save(); process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1;
}).finally(() => clearInterval(sampling));
