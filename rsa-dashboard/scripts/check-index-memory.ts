/** Rebuild disposable directories and query real archives, without touching sources.
 * node --expose-gc --import tsx scripts/check-index-memory.ts \
 *   --run /absolute/run --cache-root /absolute/isolated --output /absolute/report.json [--epoch UUID]
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdirSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
for (const key of ["--run", "--cache-root", "--output"]) assert.ok(option(key), `${key} is required`);
const run = resolve(option("--run")!), cacheRoot = resolve(option("--cache-root")!), output = resolve(option("--output")!);
assert.ok(!cacheRoot.startsWith(run + "/"), "Use an isolated disposable directory");
process.env.RSA_DASHBOARD_INDEX_ROOT = cacheRoot;
process.env.RSA_DASHBOARD_INDEX_IDLE_MS = "1";
process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES = String(32 * 1024 * 1024);
mkdirSync(dirname(output), { recursive: true });
const memory = () => process.memoryUsage();
const sourceBefore = statSync(join(run, "events.jsonl"));
const report: Record<string, any> = { run, startedAt: new Date().toISOString(), sourceBytes: sourceBefore.size,
  before: memory(), phases: [], samples: [], limitations: ["Offline worker-equivalent reader; separate HTTP validation covers Next dev and production."] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
let peakHeap = 0, peakRss = 0;
const timer = setInterval(() => { const m = memory(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 50).unref();
const bytes = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((n, entry) => n +
  (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
async function main() {
  const { getLogIndex, closeLogIndexes, indexCacheStats, pruneLogIndexes } = await import("../lib/log-index");
  const { refreshRunProjection, readRunProjection, runProgress } = await import("../lib/run-index");
  const { refreshActivity, activityProgress, queryActivity } = await import("../lib/activity");
  const { refreshOperationIndex, queryOperationRefs } = await import("../lib/operation-index");
  const index = getLogIndex(run), release = index.retain();
  const phase = async (name: string, step: () => Promise<void>) => {
    const started = performance.now(); await step(); global.gc?.();
    const value = { name, ms: performance.now() - started, memory: memory(), cache: indexCacheStats(), bytes: bytes(index.directory) };
    report.phases.push(value); save(); process.stderr.write(JSON.stringify(value) + "\n");
  };
  await phase("source-directory", async () => {
    do { await index.refreshEvents({ maxBytes: 4 * 1024 * 1024 }); } while (!index.progress.complete);
    report.events = index.eventRevision;
  });
  await phase("run-summary-locators", async () => {
    do { await refreshRunProjection(index, { maxEvents: 2000, ingest: false }); } while (!runProgress(index).complete);
  });
  await phase("activity-recipes", async () => {
    do { await refreshActivity(index, { maxEvents: 2000, ingest: false }); } while (!activityProgress(index).complete);
  });
  await phase("sparse-operations", async () => { await refreshOperationIndex(index); });
  const epoch = option("--epoch") ?? null;
  await phase("history-and-repeat", async () => {
    const scope = { project: "offline", runId: run.split("/").at(-1)!, epoch };
    const samples = [1, Math.floor(index.eventRevision / 2), index.eventRevision];
    for (const position of samples) {
      const event = await index.readEvent(position); assert.ok(event);
      report.samples.push({ position, seq: event.seq, type: event.type,
        sha256: createHash("sha256").update(JSON.stringify(event)).digest("hex") });
    }
    const stream = createReadStream(join(run, "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let position = 0;
    const expected = new Map(report.samples.map((sample: any) => [sample.position, sample.sha256]));
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        position++;
        if (expected.has(position)) assert.equal(createHash("sha256").update(JSON.stringify(JSON.parse(line))).digest("hex"), expected.get(position));
      }
    } finally { lines.close(); stream.destroy(); }
    assert.equal(position, index.eventRevision);
    report.sourceSamplesVerified = true;
    for (let i = 0; i < 5; i++) {
      const history = await queryActivity(index, scope, { mode: "history", limit: 20 });
      assert.ok(history.blocks.length);
      const block = await queryActivity(index, scope, { mode: "block", id: history.blocks[0].id });
      assert.equal(block.blocks[0].id, history.blocks[0].id);
      const page = await readRunProjection(index, epoch, {}, epoch === null);
      report.calls = page.paging.totalCalls; report.summary = page.summary;
      report.history = { total: history.total, firstVisible: history.blocks[0].id, lastVisible: history.blocks.at(-1)?.id };
      if (page.calls[0]) {
        const at = Date.parse(page.calls[0].at);
        report.overlappingOperations = (await queryOperationRefs(index, { epoch, start: at, end: at + 10_000, limit: 20 })).length;
      }
    }
  });
  report.directories = Object.fromEntries(readdirSync(index.directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, bytes(join(index.directory, e.name))]));
  release(); pruneLogIndexes(Date.now() + 10_000); await closeLogIndexes(); global.gc?.();
  report.afterClose = memory(); report.afterCloseCache = indexCacheStats();
  assert.equal(statSync(join(run, "events.jsonl")).size, sourceBefore.size);
  assert.equal(statSync(join(run, "events.jsonl")).mtimeMs, sourceBefore.mtimeMs);
  report.peakHeapSampled = peakHeap; report.peakRssSampled = peakRss;
  report.completedAt = new Date().toISOString(); report.ok = true; save(); clearInterval(timer);
}
main().catch(error => { report.error = String(error.stack ?? error); save(); process.stderr.write(report.error + "\n"); process.exitCode = 1; clearInterval(timer); });
