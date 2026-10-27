import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogIndex, closeLogIndexes, FileRecords, getLogIndex, indexCacheStats, loadIndexedEvents, pruneLogIndexes } from "../lib/log-index";
import { refreshActivity } from "../lib/activity";

test("latest-only records discard old pointers and reopen the last data segment after deletion", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-file-records-")));
  let store = new FileRecords(path);
  try {
    await store.put("large", "x".repeat(8 * 1024 * 1024));
    await store.put("removed", "last segment");
    assert.ok(store.meta("removed")?.file?.endsWith("data-000001.jsonl"));
    await store.delete("removed");
    for (let i = 0; i < 1000; i++) await store.put("state", { count: i });
    assert.equal([...store.entries()].length, 2);
    assert.equal([...store.versions()].length, 0);
    store.close();
    store = new FileRecords(path);
    assert.deepEqual(await store.get("state"), { count: 999 });
    assert.equal(await store.get("removed"), undefined);
    assert.equal([...store.versions()].length, 0);
    await store.delete("state");
    store.close();
    store = new FileRecords(path);
    assert.equal([...store.entries()].length, 1);
    await store.put("next", "after restart");
    assert.ok(store.meta("next")?.file?.endsWith("data-000001.jsonl"));
    assert.equal((await store.get<string>("large"))?.length, 8 * 1024 * 1024);
  } finally { store.close(); await rm(path, { recursive: true, force: true }); }
});

test("cache format changes rebuild stale phase state without changing source logs", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-index-upgrade-")));
  const source = JSON.stringify({ seq: 1, at: "2026-10-23T00:00:00Z", atMs: 0,
    type: "control", trace: {}, data: { mode: "manual" } }) + "\n";
  try {
    await writeFile(join(path, "events.jsonl"), source);
    let index = await getLogIndex(path);
    await index.refreshEvents();
    const generation = index.generation;
    index.setMeta("current:", JSON.stringify({ phase: { pending: { obsolete: true } } }));
    index.setMeta("format", "files-1");
    await index.flush();
    await closeLogIndexes();
    index = await getLogIndex(path);
    await index.refreshEvents();
    assert.notEqual(index.generation, generation);
    assert.equal(index.meta("current:"), undefined);
    assert.equal((await index.queryEvents()).length, 1);
    assert.equal([...index.store("events").versions()].length, 0);
    assert.equal(await readFile(join(path, "events.jsonl"), "utf8"), source);
  } finally { await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});

test("run leases protect active readers while idle indexes and pages can be evicted and reopened", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-run-cache-")));
  const oldMax = process.env.RSA_DASHBOARD_INDEX_MAX_RUNS, oldIdle = process.env.RSA_DASHBOARD_INDEX_IDLE_MS;
  process.env.RSA_DASHBOARD_INDEX_MAX_RUNS = "1";
  process.env.RSA_DASHBOARD_INDEX_IDLE_MS = "1000";
  let release: (() => void) | undefined;
  const source = JSON.stringify({ seq: 1, at: "2026-10-24T00:00:00Z", atMs: 0,
    type: "control", trace: {}, data: { mode: "manual" } }) + "\n";
  try {
    await closeLogIndexes();
    for (const run of ["first", "second"]) {
      await mkdir(join(root, run));
      await writeFile(join(root, run, "events.jsonl"), source);
    }
    const first = await getLogIndex(join(root, "first"));
    await first.refreshEvents();
    const generation = first.generation;
    release = first.retain();
    const second = await getLogIndex(join(root, "second"));
    await second.refreshEvents();
    assert.equal(indexCacheStats().leased, 1);
    pruneLogIndexes(Date.now() + 10_000);
    assert.equal(indexCacheStats().runs, 1, "only the leased run survives idle eviction");
    assert.equal(await getLogIndex(join(root, "first")), first);
    assert.equal((await first.queryEvents())[0].event.type, "control");
    assert.ok(indexCacheStats().pages > 0);
    release(); release(); release = undefined;
    pruneLogIndexes(Date.now() + 10_000);
    assert.deepEqual({ runs: indexCacheStats().runs, pages: indexCacheStats().pages, bytes: indexCacheStats().bytes },
      { runs: 0, pages: 0, bytes: 0 });
    const reopened = await getLogIndex(join(root, "first"));
    assert.notEqual(reopened, first);
    await reopened.refreshEvents();
    assert.equal(reopened.generation, generation, "eviction preserves the disk checkpoint and cursors");
    assert.equal(reopened.eventRevision, 1);
    assert.deepEqual((await reopened.queryEvents()).map(row => row.event.seq), [1]);
    assert.equal(await readFile(join(root, "first", "events.jsonl"), "utf8"), source);
  } finally {
    release?.(); await closeLogIndexes();
    if (oldMax === undefined) delete process.env.RSA_DASHBOARD_INDEX_MAX_RUNS; else process.env.RSA_DASHBOARD_INDEX_MAX_RUNS = oldMax;
    if (oldIdle === undefined) delete process.env.RSA_DASHBOARD_INDEX_IDLE_MS; else process.env.RSA_DASHBOARD_INDEX_IDLE_MS = oldIdle;
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical event addresses and small relations preserve late source time, paging and cancelled subscribers", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-event-directory-")));
  try {
    const values = Array.from({ length: 1200 }, (_, i) => ({ seq: i + 1, at: "2026-10-24T01:00:00Z", atMs: i,
      origin: { at: new Date(Date.UTC(2026, 9, 24) + (1200 - i) * 1000).toISOString() },
      type: "observation", trace: { epoch: "cycle", modelCallId: "model", traceId: "trace", spanId: `span-${i}` },
      data: { id: `image-${i}`, marker: "raw-only-payload" } }));
    await writeFile(join(path, "events.jsonl"), values.map(row => JSON.stringify(row)).join("\n") + "\n");
    const index = getLogIndex(path), controller = new AbortController();
    const cancelled = index.refreshEvents({ maxBytes: 4096, signal: controller.signal });
    const surviving = index.refreshEvents({ maxBytes: 4096 }); controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    await surviving;
    assert.ok(index.progress.bytes > 0); assert.equal(index.progress.complete, false);
    const generation = index.generation;
    await index.refreshEvents();
    assert.equal(index.generation, generation); assert.equal(index.progress.complete, true);
    const bounds = { startAt: "2026-10-24T00:00:01.000Z", endAt: "2026-10-24T00:20:00.000Z" };
    assert.deepEqual(index.timeBounds, bounds, "source extrema are independent of receive/position order");
    const selected = await index.queryEventRefs({ fromAt: "2026-10-24T00:00:01Z", toAt: "2026-10-24T00:00:03Z", limit: 2 });
    assert.deepEqual(selected.map(row => row.seq), [1198, 1199]);
    assert.equal(selected[0].file, undefined, "source path is per store, not repeated per event");
    const next = await index.queryEventRefs({ fromAt: "2026-10-24T00:00:01Z", toAt: "2026-10-24T00:00:03Z", afterPosition: selected.at(-1)!.position });
    assert.deepEqual(next.map(row => row.seq), [1200]);
    assert.deepEqual(await index.readEvent(next[0]), values[1199]);
    assert.equal((await index.queryEventRefs({ observationId: "image-100" }))[0].seq, 101);
    assert.equal(index.store("events").count(), 1200); assert.equal([...index.store("events").versions()].length, 0);
    assert.ok([...index.store("relations").entries()].every(row => Object.keys(row).sort().join() === "id,position"));
    await index.exclusive(async () => 42); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((index as any).pending, undefined, "idle queue does not retain its completed promise chain");
    await closeLogIndexes();
    const checkpointPath = join(path, ".dashboard-index", "checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    delete checkpoint.metadata["source:minTime"]; delete checkpoint.metadata["source:maxTime"];
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    const reopened = getLogIndex(path);
    assert.equal(reopened.generation, generation);
    assert.deepEqual(reopened.timeBounds, bounds, "existing page summaries recover bounds without rebuilding");
    await appendFile(join(path, "events.jsonl"), JSON.stringify({ ...values[0], seq: 1201,
      origin: { at: "2026-10-23T23:00:00Z" } }) + "\n");
    await reopened.refreshEvents();
    assert.deepEqual(reopened.timeBounds, { ...bounds, startAt: "2026-10-23T23:00:00.000Z" });
  } finally { await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});

test("parallel run loads acquire leases before any other load can evict their indexes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-parallel-run-leases-")));
  const oldMax = process.env.RSA_DASHBOARD_INDEX_MAX_RUNS;
  process.env.RSA_DASHBOARD_INDEX_MAX_RUNS = "1";
  let loaded: Awaited<ReturnType<typeof loadIndexedEvents>>[] = [];
  try {
    await closeLogIndexes();
    const paths = ["first", "second", "third"].map(run => join(root, run));
    for (const path of paths) {
      await mkdir(path);
      await writeFile(join(path, "events.jsonl"), JSON.stringify({ seq: 1, at: "2026-10-24T00:00:00Z", atMs: 0,
        type: "control", trace: {}, data: { mode: "manual" } }) + "\n");
    }
    loaded = await Promise.all(paths.map(path => loadIndexedEvents(path)));
    assert.equal(indexCacheStats().runs, 3, "temporarily exceeding the run limit is required while all requests hold leases");
    assert.equal(indexCacheStats().leased, 3);
    for (const [i, path] of paths.entries()) {
      assert.equal(await getLogIndex(path), loaded[i].index, "an active request must never continue on an orphaned index instance");
      assert.deepEqual((await loaded[i].index.queryEvents()).map(row => row.event.seq), [1]);
    }
    for (const item of loaded) item.release();
    pruneLogIndexes(Date.now() + 600_000);
    assert.equal(indexCacheStats().runs, 0);
    assert.equal(indexCacheStats().bytes, 0);
  } finally {
    // Also close orphaned instances if a regression makes an assertion fail.
    for (const item of loaded) { item.release(); item.index.close(); }
    await closeLogIndexes();
    if (oldMax === undefined) delete process.env.RSA_DASHBOARD_INDEX_MAX_RUNS; else process.env.RSA_DASHBOARD_INDEX_MAX_RUNS = oldMax;
    await rm(root, { recursive: true, force: true });
  }
});


test("shutdown drains queued preparation continuations before closing the index", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-index-drain-")));
  const index = new LogIndex(path, join(path, "index"));
  const order: string[] = [];
  try {
    const preparation = index.exclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); order.push("source");
    }).then(() => index.exclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); order.push("projection");
    }));
    await index.drain(); order.push("drained"); await preparation;
    assert.deepEqual(order, ["source", "projection", "drained"]);
  } finally { index.close(); await rm(path, { recursive: true, force: true }); }
});
