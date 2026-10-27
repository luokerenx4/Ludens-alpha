import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, realpath, rm, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { archiveBudget } from "../lib/archive-budget";
import { ArchiveBuildManager, archiveBuildState, ensureArchiveBuild, closeArchiveBuilds } from "../lib/cold-build";
import { captureSources, verifySources } from "../lib/cold-source";
import { closeLogIndexes, getLogIndex, indexStorageRoot, LogIndex } from "../lib/log-index";
import { refreshRunProjection, runProgress } from "../lib/run-index";
import { prepareArchive } from "../lib/prepare-run";

async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-cold-build-")));
  await writeFile(join(path, "events.jsonl"), JSON.stringify({ seq: 1, at: "2026-10-27T00:00:00Z", atMs: 1,
    type: "control", trace: { epoch: "cycle" }, data: { mode: "auto" } }) + "\n");
  return path;
}
async function until<T>(read: () => T, match: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = read(); if (match(value)) return value; await delay(20); } while (Date.now() < end);
  assert.fail("build state did not settle");
}
async function published(path: string) {
  const id = randomUUID(), root = indexStorageRoot(path), index = new LogIndex(path, join(root, "generations", id));
  await index.refreshEvents(); index.setMeta("cold:ready", "1"); index.close();
  await writeFile(join(root, "active.json"), JSON.stringify({ generation: id }));
  return getLogIndex(path);
}
const entry = resolve("tests/fixtures/archive-builder.mjs");

test("source capture fixes complete JSONL cutoffs, permits appends, and rejects replacement/truncation", async () => {
  const path = await fixture();
  try {
    const original = await readFile(join(path, "events.jsonl"));
    await appendFile(join(path, "events.jsonl"), '{"unfinished":');
    await mkdir(join(path, "streams")); await writeFile(join(path, "streams/m.jsonl"), '{}\n{"partial":');
    const source = await captureSources(path);
    assert.equal(source.snapshot["events.jsonl"].size, original.length);
    assert.equal(source.snapshot["streams/m.jsonl"].size, 3);
    await appendFile(join(path, "events.jsonl"), "true}\n");
    await verifySources(path, source);
    await writeFile(join(path, "events.jsonl"), "{}\n");
    await assert.rejects(verifySources(path, source), { code: "ARCHIVE_SOURCE_CHANGED" });
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("only one builder runs; cancellation is explicit, persistent, and releases the old writer", async () => {
  const paths = await Promise.all([fixture(), fixture()]);
  const manager = new ArchiveBuildManager({ entry });
  try {
    const first = await published(paths[0]!), second = getLogIndex(paths[1]!);
    const started = manager.ensure(first), queued = manager.ensure(second);
    await until(() => manager.state(first), value => value?.stage === "fixture");
    const pid = manager.state(first)!.pid!;
    assert.equal(first.frozen, true); assert.equal(manager.state(second)?.state, "queued");
    assert.equal(manager.state(second)?.pid, undefined);
    await assert.rejects(manager.control(first, { action: "cancel", buildId: queued.id }), { status: 409 });
    await manager.control(second, { action: "cancel", buildId: queued.id });
    const cancelled = await manager.control(first, { action: "cancel", buildId: started.id });
    assert.equal(cancelled?.state, "cancelled"); assert.equal(first.frozen, false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(join(indexStorageRoot(paths[0]!), "generations", started.id)));
    assert.equal(manager.ensure(first).id, started.id); // polling cannot revive it
    const recovered = new ArchiveBuildManager({ entry });
    assert.equal(recovered.ensure(first).state, "cancelled"); await recovered.close();
    first.setMeta("after-cancel", "writable"); first.flush();
  } finally { await manager.close(); await closeLogIndexes(); for (const path of paths) await rm(path, { recursive: true, force: true }); }
});

test("a failed child preserves the published generation and requires an explicit matching retry", async () => {
  const path = await fixture(), manager = new ArchiveBuildManager({ entry, env: { ...process.env, BUILDER_FIXTURE_FAIL: "1" } });
  try {
    const index = await published(path), pointer = await readFile(join(indexStorageRoot(path), "active.json"), "utf8");
    const first = manager.ensure(index);
    const failed = await until(() => manager.state(index), value => value?.state === "failed");
    assert.match(failed!.error!, /fixture build failed/);
    assert.equal(index.frozen, false);
    assert.equal(await readFile(join(indexStorageRoot(path), "active.json"), "utf8"), pointer);
    assert.equal(manager.ensure(index).id, first.id);
    const next = await manager.control(index, { action: "retry", buildId: first.id });
    assert.notEqual(next!.id, first.id);
    await manager.control(index, { action: "cancel", buildId: next!.id });
  } finally { await manager.close(); await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});

test("closing the manager stops a running child and cancels queued work without publishing", async () => {
  const path = await fixture(), manager = new ArchiveBuildManager({ entry });
  try {
    const index = getLogIndex(path); manager.ensure(index);
    await until(() => manager.state(index), value => value?.stage === "fixture");
    const pid = manager.state(index)!.pid!;
    await manager.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(manager.state(index)?.state, "cancelled");
    await assert.rejects(access(join(indexStorageRoot(path), "active.json")));
  } finally { await manager.close(); await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});

test("reader and builder heap ceilings leave room above their configurable working budgets", () => {
  assert.deepEqual(archiveBudget({}), { cacheBytes: 256 * 1024 ** 2, buildBytes: 2 * 1024 ** 3, readerHeapMiB: 1024, builderHeapMiB: 4096 });
  const larger = archiveBudget({ RSA_DASHBOARD_INDEX_CACHE_BYTES: String(512 * 1024 ** 2), RSA_DASHBOARD_BUILD_BYTES: String(4 * 1024 ** 3) });
  assert.equal(larger.readerHeapMiB, 1792); assert.equal(larger.builderHeapMiB, 7168);
});

test("a builder exits when its worker owner terminates abruptly", async () => {
  const path = await fixture(), worker = new Worker(resolve("tests/fixtures/build-owner.mjs"), { workerData: { path } });
  let pid: number | undefined;
  try {
    pid = await new Promise<number>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await worker.terminate();
    // Abrupt native-worker teardown can leave a defunct child until the parent
    // process exits. It must not leave a running builder consuming memory/CPU.
    await until(() => { try { return execFileSync("ps", ["-p", String(pid), "-o", "stat="], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
      catch { return ""; } }, status => !status || status.startsWith("Z"), 3000);
  } finally {
    await worker.terminate();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
    await rm(path, { recursive: true, force: true });
  }
});

test("real cold construction publishes a complete generation, retires leased readers, and accepts a warm tail", async () => {
  const path = await fixture(), manager = new ArchiveBuildManager();
  let release: (() => void) | undefined;
  try {
    const original = await readFile(join(path, "events.jsonl"), "utf8"), index = getLogIndex(path);
    release = index.retain();
    const first = manager.ensure(index);
    let pid: number | undefined;
    const result = await until(() => { const state = manager.state(index); pid ??= state?.pid; return state; },
      value => value?.state === "ready" || value?.state === "failed");
    assert.equal(result?.state, "ready", result?.error);
    assert.equal(result.id, first.id); assert.equal(result.eventPosition, 1);
    assert.ok(result.metrics && Number(result.metrics.eventParses) === 1);
    assert.equal(result.replayHint?.controls.length, 1);
    assert.equal(result.pid, undefined);
    if (pid) assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    const next = getLogIndex(path);
    assert.notEqual(next, index); assert.equal(next.meta("cold:ready"), "1");
    assert.equal(next.meta("run_position"), "1"); assert.equal(next.meta("operations:position"), "1");
    assert.equal((await next.readEvent(1))?.type, "control");
    await access(index.directory);
    release(); release = undefined;
    await assert.rejects(access(index.directory));
    assert.equal((await manager.control(next, { action: "cancel", buildId: first.id }))?.state, "ready");
    await access(next.directory);
    assert.equal(await readFile(join(path, "events.jsonl"), "utf8"), original);
    await appendFile(join(path, "events.jsonl"), JSON.stringify({ seq: 2, at: "2026-10-27T00:00:01Z", atMs: 2,
      type: "control", trace: { epoch: "cycle" }, data: { mode: "manual" } }) + "\n");
    await refreshRunProjection(next);
    assert.equal(next.eventRevision, 2); assert.equal(next.meta("run_position"), "2");
  } finally { release?.(); await manager.close(); await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});

test("published partial tails remain readable and a replaced source triggers a new finite build", async () => {
  const path = await fixture();
  try {
    const partial = '{"seq":2,"at":"2026-10-27T00:00:01Z","atMs":2,"type":"control","trace":{"epoch":"cycle"},"data":';
    await appendFile(join(path, "events.jsonl"), partial);
    let index = getLogIndex(path);
    const first = ensureArchiveBuild(index);
    const ready = await until(() => archiveBuildState(index), value => value?.state === "ready" || value?.state === "failed");
    assert.equal(ready?.state, "ready", ready?.error);
    index = getLogIndex(path);
    const prepare = () => prepareArchive(index, { kind: "run", step: signal => refreshRunProjection(index, { maxEvents: 2000, ingest: false, signal }),
      progress: () => runProgress(index) });
    await prepare();
    assert.equal(index.eventRevision, 1); assert.equal(index.progress.complete, true);
    await appendFile(join(path, "events.jsonl"), '{"mode":"manual"}}\n');
    await prepare(); assert.equal(index.eventRevision, 2);
    await writeFile(join(path, "events.jsonl"), JSON.stringify({ seq: 1, at: "2026-10-28T00:00:00Z", atMs: 1,
      type: "control", trace: { epoch: "replacement" }, data: { mode: "auto" } }) + "\n");
    await assert.rejects(prepare(), { status: 202, code: "ARCHIVE_PREPARING" });
    const rebuilt = await until(() => archiveBuildState(index), value => value?.state === "ready" || value?.state === "failed");
    assert.equal(rebuilt?.state, "ready", rebuilt?.error); assert.notEqual(rebuilt.id, first.id);
    index = getLogIndex(path); await prepare();
    assert.equal(index.eventRevision, 1); assert.equal((await index.readEvent(1))?.trace.epoch, "replacement");
  } finally { await closeArchiveBuilds(); await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});
