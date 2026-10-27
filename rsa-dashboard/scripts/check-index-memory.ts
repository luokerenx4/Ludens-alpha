/** Rebuild disposable directories and query real archives, without touching sources.
 * node --expose-gc --import tsx scripts/check-index-memory.ts \
 *   --run /absolute/run --cache-root /absolute/isolated --output /absolute/report.json [--epoch UUID]
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdirSync, statSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
for (const key of ["--run", "--cache-root", "--output"]) assert.ok(option(key), `${key} is required`);
const run = resolve(option("--run")!), cacheRoot = resolve(option("--cache-root")!), output = resolve(option("--output")!);
assert.ok(!cacheRoot.startsWith(run + "/"), "Use an isolated disposable directory");
process.env.RSA_DASHBOARD_INDEX_ROOT = cacheRoot;
process.env.RSA_DASHBOARD_INDEX_IDLE_MS = "1";
if (option("--cache-bytes")) process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES = option("--cache-bytes");
if (option("--build-bytes")) process.env.RSA_DASHBOARD_BUILD_BYTES = option("--build-bytes");
mkdirSync(dirname(output), { recursive: true });
const memory = () => process.memoryUsage();
const sourceBefore = statSync(join(run, "events.jsonl"));
const report: Record<string, any> = { run, startedAt: new Date().toISOString(), sourceBytes: sourceBefore.size,
  before: memory(), phases: [], samples: [], limitations: ["Offline worker-equivalent reader; separate HTTP validation covers Next dev and production."] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
let peakHeap = 0, peakRss = 0, peakCombinedRss = 0;
const childPids = new Set<number>();
const timer = setInterval(() => { const m = memory(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 50).unref();
const bytes = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((n, entry) => n +
  (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
async function main() {
  const { getLogIndex, closeLogIndexes, indexCacheStats, pruneLogIndexes, storageMetrics } = await import("../lib/log-index");
  const { readRunProjection } = await import("../lib/run-index");
  const { queryActivity } = await import("../lib/activity");
  const { queryOperationRefs } = await import("../lib/operation-index");
  const { ensureArchiveBuild, controlArchiveBuild, closeArchiveBuilds } = await import("../lib/cold-build");
  const { archiveBudget } = await import("../lib/archive-budget");
  report.budget = archiveBudget();
  let index = getLogIndex(run);
  try { index.archiveWorkspace = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8")).workspace; } catch { /* Offline fixtures may omit manifests. */ }
  const phase = async (name: string, step: () => Promise<void>) => {
    const started = performance.now(); await step(); global.gc?.();
    const value = { name, ms: performance.now() - started, memory: memory(), cache: indexCacheStats(), bytes: bytes(index.directory) };
    report.phases.push(value); save(); process.stderr.write(JSON.stringify(value) + "\n");
  };
  await phase("cold-build", async () => {
    ensureArchiveBuild(index);
    const started = Date.now();
    for (;;) {
      const state = await controlArchiveBuild(index, {});
      assert.ok(state, "Build state missing");
      report.build = state;
      if (state.pid) {
        childPids.add(state.pid);
        try {
          const rssKiB = execFileSync("ps", ["-o", "rss=", "-p", `${process.pid},${state.pid}`], { encoding: "utf8" })
            .trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
          peakCombinedRss = Math.max(peakCombinedRss, rssKiB * 1024);
        } catch { /* Child may exit between progress and process sampling. */ }
      }
      if (state.state === "ready") break;
      assert.ok(state.state === "queued" || state.state === "building", state.error ?? state.state);
      assert.ok(Date.now() - started < 15 * 60_000, "Archive build exceeded benchmark timeout");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    index = getLogIndex(run); report.events = index.eventRevision;
  });
  const release = index.retain();
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
  report.queryMetrics = { ...storageMetrics };
  if (option("--compare")) {
    const expected = JSON.parse(readFileSync(option("--compare")!, "utf8"));
    for (const field of ["events", "calls", "summary", "history", "samples"]) assert.deepEqual(report[field], expected[field], `Mismatch: ${field}`);
    report.baselineMatches = true;
  }
  report.directories = Object.fromEntries(readdirSync(index.directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, bytes(join(index.directory, e.name))]));
  release(); await closeArchiveBuilds(); pruneLogIndexes(Date.now() + 10_000); await closeLogIndexes(); global.gc?.();
  report.afterClose = memory(); report.afterCloseCache = indexCacheStats();
  assert.equal(statSync(join(run, "events.jsonl")).size, sourceBefore.size);
  assert.equal(statSync(join(run, "events.jsonl")).mtimeMs, sourceBefore.mtimeMs);
  report.peakHeapSampled = peakHeap; report.peakRssSampled = peakRss;
  report.peakCombinedRssSampled = peakCombinedRss;
  report.builderPids = [...childPids];
  report.buildersExited = [...childPids].every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.ok(report.buildersExited, "Builder process did not exit");
  report.completedAt = new Date().toISOString(); report.ok = true; save(); clearInterval(timer);
}
main().catch(async error => {
  report.error = String(error.stack ?? error); save(); process.stderr.write(report.error + "\n"); process.exitCode = 1;
  const { closeArchiveBuilds } = await import("../lib/cold-build");
  const { closeLogIndexes } = await import("../lib/log-index");
  await closeArchiveBuilds(); await closeLogIndexes(); clearInterval(timer);
});
