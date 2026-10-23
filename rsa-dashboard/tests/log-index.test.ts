import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLogIndexes, FileRecords, getLogIndex } from "../lib/log-index";

test("latest-only records discard old pointers and reopen the last data segment after deletion", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-file-records-")));
  let store = new FileRecords(path);
  try {
    await store.put("large", "x".repeat(8 * 1024 * 1024));
    await store.put("removed", "last segment");
    assert.ok(store.meta("removed")?.file.endsWith("data-000001.jsonl"));
    await store.delete("removed");
    for (let i = 0; i < 1000; i++) await store.put("state", { count: i });
    assert.equal([...store.entries()].length, 2);
    assert.equal(store.versions().length, 0);
    store.close();
    store = new FileRecords(path);
    assert.deepEqual(await store.get("state"), { count: 999 });
    assert.equal(await store.get("removed"), undefined);
    assert.equal(store.versions().length, 0);
    await store.delete("state");
    store.close();
    store = new FileRecords(path);
    assert.equal([...store.entries()].length, 1);
    await store.put("next", "after restart");
    assert.ok(store.meta("next")?.file.endsWith("data-000001.jsonl"));
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
    assert.equal(index.store("events").versions().length, 1);
    assert.equal(await readFile(join(path, "events.jsonl"), "utf8"), source);
  } finally { await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
});
