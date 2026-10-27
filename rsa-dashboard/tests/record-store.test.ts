import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BulkBudget, FileRecords, recordCacheStats, resetStorageMetrics, storageMetrics, type RecordPointer } from "../lib/record-store";

const id = (n: number) => `record-${String(n).padStart(5, "0")}`;
async function fixture(work: (path: string) => Promise<void>) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-record-pages-")));
  const oldLimit = process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES;
  process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES = String(1024 * 1024);
  try { await work(path); }
  finally {
    if (oldLimit === undefined) delete process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES;
    else process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES = oldLimit;
    await rm(path, { recursive: true, force: true });
  }
}

test("legacy indexes migrate in pages, retain immutable history, and reopen after cache eviction", async () => fixture(async path => {
  const dataFile = join(path, "data-000000.jsonl"), pointers: RecordPointer[] = [];
  let body = "";
  const append = (n: number, revision: number, value: string) => {
    const line = JSON.stringify({ value }) + "\n";
    pointers.push({ id: id(n), file: dataFile, offset: Buffer.byteLength(body), length: Buffer.byteLength(line),
      revision, epoch: "cycle", kind: "text", status: "complete", at: "2026-10-24T00:00:00Z" });
    body += line;
  };
  for (let n = 0; n < 6000; n++) append(n, n + 1, `最初 ${n}`);
  append(5, 6001, "late correction");
  pointers.push({ id: id(23), file: "", offset: 0, length: 0, deleted: true });
  const legacy = pointers.map(pointer => JSON.stringify(pointer)).join("\n") + "\n";
  assert.ok(Buffer.byteLength(legacy) > 1024 * 1024, "fixture spans source read chunks and index pages");
  await writeFile(dataFile, body);
  await writeFile(join(path, "index.jsonl"), legacy);
  let store = new FileRecords(path, () => {}, true);
  try {
    assert.equal(store.count(), 5999);
    assert.equal(store.count({ epoch: "cycle", kind: "text", status: "complete" }), 5999);
    assert.deepEqual(await store.get(id(5)), { value: "late correction" });
    assert.equal(await store.get(id(23)), undefined);
    const tail = [...store.versions({ after: 5998 })];
    assert.deepEqual(tail.map(pointer => pointer.revision), [5999, 6000, 6001]);
    const original = [...store.versions({ after: 5, before: 7 })][0];
    assert.deepEqual(await store.read(original), { value: "最初 5" });
    // Traverse more pages than fit in the hot cache, then revisit the first page.
    let count = 0;
    for (const _ of store.entries()) count++;
    assert.equal(count, 5999);
    assert.ok(recordCacheStats().bytes <= recordCacheStats().limit);
    assert.deepEqual(await store.get(id(0)), { value: "最初 0" });
    assert.equal(await readFile(join(path, "index.jsonl"), "utf8"), legacy);
    assert.equal(await readFile(dataFile, "utf8"), body, "migration does not rewrite historical bodies");
    store.close();
    store = new FileRecords(path, () => {}, true);
    assert.equal(store.count(), 5999);
    assert.deepEqual(await store.get(id(5)), { value: "late correction" });
    assert.deepEqual([...store.versions({ after: 5998, reverse: true })].map(pointer => pointer.revision), [6001, 6000, 5999]);
    await store.put("new", { value: "after restart" }, { revision: 6002, epoch: "other", kind: "tool", status: "running" });
    assert.equal(store.count({ epoch: "other", status: "running" }), 1);
    assert.deepEqual(await store.get("new"), { value: "after restart" });
  } finally { store.close(); }
  assert.equal(recordCacheStats().pages, 0);
}));

test("random replacements and whole-page deletions keep lookup, facets and prefixes accurate after restart", async () => fixture(async path => {
  type Row = { value: number; epoch: string; kind: string; status: string; revision: number };
  const expected = new Map<string, Row>();
  let revision = 0, store = new FileRecords(path, () => {}, true);
  const put = async (n: number, value: number) => {
    const row = { value, epoch: n % 3 ? "cycle" : "other", kind: n % 2 ? "tool" : "text",
      status: value % 2 ? "running" : "complete", revision: ++revision };
    expected.set(id(n), row); await store.put(id(n), row, row);
  };
  try {
    // Coprime stride gives a deterministic random insertion order over many pages.
    for (let n = 0; n < 4000; n++) await put((n * 97) % 4000, n);
    for (let n = 0; n < 700; n++) await put((n * 101) % 4000, 10000 + n);
    for (let n = 1000; n < 2500; n++) { await store.delete(id(n)); expected.delete(id(n)); }
    await store.delete("missing");
    const verify = async () => {
      assert.equal(store.count(), expected.size);
      const filter = { epoch: "cycle", kind: "tool", status: "running" };
      const matching = [...expected].filter(([, row]) => Object.entries(filter).every(([key, value]) => row[key as keyof Row] === value));
      assert.equal(store.count(filter), matching.length);
      assert.deepEqual([...store.entries({ where: filter })].map(pointer => pointer.id), matching.map(([key]) => key).sort());
      const prefix = "record-000";
      assert.deepEqual([...store.entries({ prefix })].map(pointer => pointer.id), [...expected.keys()].filter(key => key.startsWith(prefix)).sort());
      for (let n = 0; n < 4000; n += 37) assert.deepEqual(await store.get(id(n)), expected.get(id(n)));
      assert.equal(await store.get(id(1500)), undefined);
      assert.ok(recordCacheStats().bytes <= recordCacheStats().limit);
    };
    await verify();
    store.close(); store = new FileRecords(path, () => {}, true);
    await verify();
    const last = [...store.versions({ after: revision - 10, where: { epoch: "cycle" } })];
    assert.ok(last.every(pointer => pointer.revision > revision - 10 && pointer.epoch === "cycle"));
    assert.deepEqual([...store.versions({ after: revision - 10, reverse: true, where: { epoch: "cycle" } })], last.toReversed());
    // Reusing a fully removed key must not be hidden by stale empty-page bounds.
    await put(1500, 20000);
    assert.deepEqual(await store.get(id(1500)), expected.get(id(1500)));
    assert.equal(store.count(), expected.size);
  } finally { store.close(); }
  assert.equal(recordCacheStats().pages, 0);
}));

test("deleting entries during iteration visits every row across emptied pages", async () => fixture(async path => {
  let store = new FileRecords(path);
  try {
    for (let n = 0; n < 2500; n++) await store.put(id(n), n);
    const visited: string[] = [];
    for (const pointer of store.entries()) {
      visited.push(pointer.id);
      await store.delete(pointer.id);
    }
    assert.deepEqual(visited, Array.from({ length: 2500 }, (_, n) => id(n)));
    assert.equal(store.count(), 0);
    assert.deepEqual([...store.entries()], []);
    store.close(); store = new FileRecords(path);
    assert.equal(store.count(), 0);
    await store.put(id(1200), "after clear");
    assert.equal(await store.get(id(1200)), "after clear");
  } finally { store.close(); }
}));

test("one oversized metadata pointer remains readable without entering the hot cache", async () => fixture(async path => {
  const metadata = "m".repeat(1024 * 1024 + 1);
  let store = new FileRecords(path);
  try {
    await store.put("large", { value: "small body" }, { detail: metadata });
    assert.equal(recordCacheStats().pages, 0, "oversized writes bypass the page cache");
    assert.equal(recordCacheStats().bytes, 0);
    assert.equal(store.meta("large")?.detail, metadata);
    assert.deepEqual(await store.get("large"), { value: "small body" });
    assert.equal(recordCacheStats().pages, 0, "oversized reads also bypass the page cache");
    store.close(); store = new FileRecords(path);
    assert.equal(store.count(), 1);
    assert.equal(store.meta("large")?.detail, metadata);
    assert.deepEqual(await store.get("large"), { value: "small body" });
    assert.equal(recordCacheStats().bytes, 0);
    await store.delete("large");
    assert.equal(store.count(), 0);
    assert.ok(recordCacheStats().bytes <= recordCacheStats().limit);
  } finally { store.close(); }
}));

test("bulk migration merges sorted chunks by last source occurrence while history keeps source order", async () => fixture(async path => {
  const dataFile = join(path, "data-000000.jsonl"), source: string[] = [], bodies: string[] = [];
  const expected = new Map<string, number>();
  let offset = 0, revision = 0;
  const append = (key: string) => {
    const value = ++revision, body = JSON.stringify({ value }) + "\n";
    source.push(JSON.stringify({ id: key, file: dataFile, offset, length: Buffer.byteLength(body), revision: value,
      epoch: "cycle", kind: "text", status: "complete" }));
    bodies.push(body); offset += Buffer.byteLength(body); expected.set(key, value);
  };
  // More than two 16k sorting chunks, with the same IDs recurring across chunk boundaries.
  for (let n = 0; n < 47000; n++) append(id((n * 7919) % 20000));
  for (let n = 0; n < 20000; n += 101) {
    source.push(JSON.stringify({ id: id(n), file: "", offset: 0, length: 0, deleted: true }));
    expected.delete(id(n));
  }
  append(id(0)); // A later write revives a deleted ID.
  const legacy = source.join("\n") + "\n";
  await writeFile(dataFile, bodies.join(""));
  await writeFile(join(path, "index.jsonl"), legacy);
  let store = new FileRecords(path, () => {}, true);
  try {
    assert.equal(store.count(), expected.size);
    assert.deepEqual([...store.entries()].map(row => [row.id, row.revision]), [...expected].sort(([a], [b]) => a.localeCompare(b)));
    for (let n = 0; n < 20000; n += 997) {
      const value = expected.get(id(n));
      assert.deepEqual(await store.get(id(n)), value === undefined ? undefined : { value });
    }
    const versions = [...store.versions({ after: 46000 })];
    assert.deepEqual(versions.map(row => row.revision), Array.from({ length: 1001 }, (_, n) => n + 46001));
    assert.equal(versions.at(-1)?.id, id(0));
    assert.equal(recordCacheStats().bytes <= recordCacheStats().limit, true);
    assert.equal((await readdir(store.pageDirectory)).includes("import"), false);
    assert.equal(await readFile(join(path, "index.jsonl"), "utf8"), legacy);
    store.close(); store = new FileRecords(path, () => {}, true);
    assert.equal(store.count(), expected.size);
    assert.deepEqual(await store.get(id(0)), { value: 47001 });
    assert.equal(await store.get(id(101)), undefined);
  } finally { store.close(); }
}));

test("failed legacy import leaves the original source intact and publishes no partial manifest", async () => fixture(async path => {
  const dataFile = join(path, "data-000000.jsonl");
  await writeFile(dataFile, "{}\n");
  const valid = Array.from({ length: 1500 }, (_, n) => JSON.stringify({ id: id(n), file: dataFile, offset: 0, length: 3, revision: n + 1 })).join("\n") + "\n";
  const broken = valid + "not valid json\n";
  await writeFile(join(path, "index.jsonl"), broken);
  assert.throws(() => new FileRecords(path, () => {}, true), SyntaxError);
  assert.equal(recordCacheStats().pages, 0);
  assert.equal(await readFile(join(path, "index.jsonl"), "utf8"), broken);
  assert.equal((await readdir(join(path, "pages"))).includes("manifest.json"), false);
  assert.equal((await readdir(join(path, "pages"))).includes("import"), false);
  await writeFile(join(path, "index.jsonl"), valid);
  const store = new FileRecords(path, () => {}, true);
  try {
    assert.equal(store.count(), 1500);
    assert.deepEqual(await store.get(id(1499)), {});
  } finally { store.close(); }
}));

test("empty stores can bulk-seed streamed references without overwriting an existing index", async () => fixture(async path => {
  const body = '{"value":"initial"}\n{"value":"updated"}\n', file = join(path, "original.jsonl");
  await writeFile(file, body);
  const split = body.indexOf("\n") + 1;
  let writes = 0, consumed = 0;
  let store = new FileRecords(join(path, "derived"), () => { writes++; }, true);
  const records = function* (): Generator<RecordPointer> {
    yield { id: "a", file, offset: 0, length: split, revision: 1 };
    yield { id: "b", file, offset: 0, length: split, revision: 2 };
    yield { id: "a", file, offset: split, length: body.length - split, revision: 3 };
    yield { id: "b", file: "", offset: 0, length: 0, deleted: true };
    yield { id: "c", file, offset: split, length: body.length - split, revision: 4 };
  };
  const forbidden = function* () { consumed++; yield* records(); };
  try {
    store.seed(records());
    assert.equal(writes, 1, "bulk seed participates in the owning index write lifecycle");
    assert.equal(store.count(), 2);
    assert.deepEqual(await store.get("a"), { value: "updated" });
    assert.equal(await store.get("b"), undefined);
    assert.deepEqual([...store.versions()].map(row => row.revision), [1, 2, 3, 4]);
    assert.throws(() => store.seed(forbidden()), /empty store/);
    assert.equal(consumed, 0, "nonempty rejection happens before consuming or mutating input");
    assert.equal(writes, 1);
    store.close(); store = new FileRecords(join(path, "derived"), () => { writes++; }, true);
    assert.throws(() => store.seed(forbidden()), /empty store/);
    assert.equal(store.count(), 2);
    assert.deepEqual(await store.get("c"), { value: "updated" });
    assert.equal(await readFile(file, "utf8"), body);
  } finally { store.close(); }
}));

test("range reads skip other pages and reverse only the selected interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "records-range-"));
  const store = new FileRecords(directory);
  try {
    for (let i = 0; i < 2300; i++) await store.put(String(i).padStart(5, "0"), i);
    const options = { afterId: "00995", beforeId: "01005" };
    const forward = [...store.entries(options)].map(entry => entry.id);
    assert.deepEqual(forward, Array.from({ length: 9 }, (_, i) => String(i + 996).padStart(5, "0")));
    assert.deepEqual([...store.entries({ ...options, reverse: true })].map(entry => entry.id), forward.toReversed());
    assert.deepEqual([...store.entries({ afterId: "99999", beforeId: "zzzzz" })], []);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cold tables share a spill budget and preserve reads, replacement and deletion across spill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "records-cold-budget-"));
  const budget = new BulkBudget(12 * 1024);
  let first = new FileRecords(join(directory, "first")), second = new FileRecords(join(directory, "second"));
  resetStorageMetrics(); first.beginBulk(budget); second.beginBulk(budget);
  try {
    for (let i = 0; i < 150; i++) {
      first.index(`key-${i}`, { value: i });
      await second.put(`key-${i}`, { value: i });
      assert.ok(budget.bytes <= budget.limit);
      assert.equal(first.meta(`key-${i}`)?.value, i);
      assert.deepEqual(await second.get(`key-${i}`), { value: i });
    }
    first.index("key-0", { value: 999 }); await second.put("key-0", { value: 999 });
    await first.delete("key-1"); await second.delete("key-1");
    assert.equal(first.meta("key-1"), undefined); assert.equal(await second.get("key-1"), undefined);
    first.finishBulk(); second.finishBulk();
    assert.equal(budget.bytes, 0); assert.equal(budget.stores.size, 0);
    assert.ok(storageMetrics.bulkSpills > 0);
    assert.equal(first.count(), 149); assert.equal(second.count(), 149);
    first.close(); second.close();
    first = new FileRecords(join(directory, "first")); second = new FileRecords(join(directory, "second"));
    assert.equal(first.meta("key-0")?.value, 999); assert.deepEqual(await second.get("key-0"), { value: 999 });
    assert.equal(first.meta("key-1"), undefined); assert.equal(await second.get("key-1"), undefined);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a cold table fitting its workset writes final pages without random intermediate rewrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "records-cold-pages-"));
  const store = new FileRecords(directory), budget = new BulkBudget(16 * 1024 * 1024);
  resetStorageMetrics(); store.beginBulk(budget);
  try {
    for (let i = 4999; i >= 0; i--) store.index(String(i).padStart(6, "0"), { value: i });
    for (let i = 0; i < 5000; i++) store.index(String(i).padStart(6, "0"), { value: i + 1 });
    assert.equal(storageMetrics.pageWrites, 0);
    store.finishBulk(); store.flush();
    assert.equal(store.count(), 5000); assert.equal(store.meta("000000")?.value, 1);
    assert.equal(storageMetrics.pageWrites, 5);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cold snapshot history contains one final version per block after repeated spills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "records-cold-history-"));
  const store = new FileRecords(directory, () => {}, true), budget = new BulkBudget(1024);
  store.beginBulk(budget);
  try {
    for (let pass = 0; pass < 3; pass++) for (let i = 29; i >= 0; i--)
      store.index(`block-${i}`, { revision: i + 1, createdRevision: i + 1, pass });
    store.finishBulk(); store.flush();
    const versions = [...store.versions()];
    assert.equal(versions.length, 30);
    assert.deepEqual(versions.map(row => row.revision), Array.from({ length: 30 }, (_, i) => i + 1));
    assert.ok(versions.every(row => row.pass === 2));
    store.index("block-0", { revision: 31, createdRevision: 1, pass: 3 });
    assert.deepEqual([...store.versions({ after: 30 })].map(row => row.revision), [31]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
