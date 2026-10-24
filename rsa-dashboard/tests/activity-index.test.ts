import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshActivity, queryActivity, type LogBlock } from "../lib/activity";
import { getLogIndex, closeLogIndexes } from "../lib/log-index";
import type { Event } from "../lib/types";

const scope = { project: "fixture", runId: "run", epoch: "cycle" };
const event = (seq: number, type: string, data: Record<string, unknown> = {}): Event => ({
  seq, type, at: new Date(Date.UTC(2026, 9, 21, 0, 0, seq)).toISOString(), atMs: seq * 1000,
  data, trace: { epoch: "cycle", ...(type === "control" ? {} : { modelCallId: "model" }) },
});
const frame = (type: string, item_id: string, text: string, sequence: number) => JSON.stringify({
  atMs: sequence * 1000, event: { data: JSON.stringify({ type, item_id,
    ...(type.endsWith("delta") ? { delta: text } : { text }), sequence_number: sequence }) },
}) + "\n";
async function fixture(work: (path: string) => Promise<void>) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-activity-index-")));
  try {
    await mkdir(join(path, "streams"));
    await writeFile(join(path, "events.jsonl"), [event(1, "control", { mode: "auto" }), event(2, "model_start")].map(value => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(join(path, "streams/model.jsonl"), "");
    await work(path);
  } finally { await closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
}

test("activity indexes stream-only appends and defers incomplete UTF-8 JSONL records", async () => fixture(async path => {
  const index = await getLogIndex(path);
  await refreshActivity(index);
  const first = await queryActivity(index, scope);
  assert.equal(first.mode, "snapshot");
  if (!("cursor" in first)) throw new Error("snapshot cursor missing");
  const line = frame("response.output_text.delta", "message", "你好", 1);
  const bytes = Buffer.from(line), cut = bytes.indexOf(Buffer.from("好")) + 1;
  await appendFile(join(path, "streams/model.jsonl"), bytes.subarray(0, cut));
  await refreshActivity(index);
  const partial = await queryActivity(index, scope, { cursor: first.cursor });
  assert.equal(partial.blocks.length, 0);
  await appendFile(join(path, "streams/model.jsonl"), bytes.subarray(cut));
  await refreshActivity(index);
  const completed = await queryActivity(index, scope, { cursor: first.cursor });
  assert.equal(completed.blocks.find(block => block.kind === "text")?.text, "你好");
  assert.equal(index.eventRevision, 2, "stream advances independently of events.jsonl");
}));

test("immutable delta pagination delivers creation before late updates, including old blocks", async () => fixture(async path => {
  const index = await getLogIndex(path);
  await refreshActivity(index);
  const initial = await queryActivity(index, scope);
  if (!("cursor" in initial)) throw new Error("snapshot cursor missing");
  await appendFile(join(path, "streams/model.jsonl"), frame("response.output_text.delta", "old", "first", 1) + frame("response.output_text.done", "other", "second", 2));
  await refreshActivity(index);
  await appendFile(join(path, "events.jsonl"), JSON.stringify(event(3, "model_end", { stopReason: "stop" })) + "\n");
  await refreshActivity(index);
  await appendFile(join(path, "streams/model.jsonl"), frame("response.output_text.done", "old", "late completed", 3));
  await refreshActivity(index);
  let cursor = initial.cursor;
  const delivered = [];
  for (let pages = 0; pages < 20; pages++) {
    const page = await queryActivity(index, scope, { cursor, limit: 1 });
    assert.equal(page.mode, "delta");
    if (!("cursor" in page)) throw new Error("delta cursor missing");
    delivered.push(...page.blocks); cursor = page.cursor;
    if (!page.hasMore) break;
    assert.equal(page.projection.revision, page.blocks.at(-1)?.revision);
  }
  const updates = delivered.filter(block => block.id === "model:text:old:0");
  assert.equal(updates[0].createdRevision, updates[0].revision);
  assert.equal(updates.at(-1)?.text, "late completed");
  assert.ok(updates.at(-1)!.revision! > updates[0].revision!);
  assert.ok(updates.every(block => block.createdRevision === updates[0].createdRevision));
  assert.equal((await queryActivity(index, scope, { cursor })).blocks.length, 0);
  const history = await queryActivity(index, scope, { mode: "history", kind: "text" });
  assert.equal(history.blocks.length, 2, "history returns current blocks, not every version");
}));

test("history filtering, display-order cursors and lookup remain separate from change cursors", async () => fixture(async path => {
  const index = await getLogIndex(path);
  await appendFile(join(path, "streams/model.jsonl"), ["a", "B", "c"].map((id, i) => frame("response.output_text.done", id, `Needle ${id}`, i + 1)).join(""));
  await refreshActivity(index);
  const newest = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", limit: 2 });
  assert.equal(newest.mode, "history");
  if (!("before" in newest)) throw new Error("history cursor missing");
  assert.equal(newest.total, 3); assert.equal(newest.blocks.length, 2); assert.equal(newest.hasMore, true);
  const older = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", before: newest.before!, limit: 2 });
  assert.equal(older.blocks.length, 1); assert.equal(older.hasMore, false);
  const ids = [...newest.blocks, ...older.blocks].map(block => block.id);
  assert.equal(new Set(ids).size, 3);
  const lookup = await queryActivity(index, scope, { mode: "block", id: ids[0] });
  assert.equal(lookup.blocks[0].id, ids[0]);
  const all = await queryActivity(index, scope, { mode: "history" });
  assert.ok(all.blocks.every(block => block.kind !== "diagnostic"));
  assert.equal((await queryActivity(index, { ...scope, epoch: "other" }, { mode: "block", id: ids[0] })).blocks.length, 0);
}));

test("restart reuses file checkpoints; source truncation invalidates old cursors and rebuilds", async () => fixture(async path => {
  await appendFile(join(path, "streams/model.jsonl"), frame("response.output_text.done", "message", "Original message", 1));
  let index = await getLogIndex(path);
  await refreshActivity(index);
  const first = await queryActivity(index, scope);
  if (!("cursor" in first)) throw new Error("snapshot cursor missing");
  const revision = index.revision, generation = index.generation;
  await closeLogIndexes();
  index = await getLogIndex(path);
  await refreshActivity(index);
  assert.equal(index.generation, generation); assert.equal(index.revision, revision);
  assert.equal((await queryActivity(index, scope, { cursor: first.cursor })).blocks.length, 0);
  await writeFile(join(path, "streams/model.jsonl"), frame("response.output_text.done", "new", "New", 1));
  await refreshActivity(index);
  assert.notEqual(index.generation, generation);
  const rebuilt = await queryActivity(index, scope, { cursor: first.cursor });
  assert.equal(rebuilt.mode, "snapshot");
  assert.equal(rebuilt.blocks.find(block => block.kind === "text")?.text, "New");
  assert.equal(rebuilt.blocks.some(block => block.id === "model:text:message:0"), false);
  const previous = index.generation;
  await writeFile(join(path, "events.jsonl"), JSON.stringify(event(1, "control", { mode: "manual" })) + "\n");
  await refreshActivity(index);
  assert.notEqual(index.generation, previous); assert.equal(index.eventRevision, 1);
  assert.ok((await readFile(join(path, "events.jsonl"), "utf8")).includes('"manual"'));
}));


test("abandoned history searches stop at a bounded yield without cancelling the shared index", async () => fixture(async path => {
  const index = await getLogIndex(path);
  await appendFile(join(path, "streams/model.jsonl"), Array.from({ length: 300 }, (_, i) =>
    frame("response.output_text.done", `item-${i}`, "searchable", i + 1)).join(""));
  await refreshActivity(index);
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await assert.rejects(queryActivity(index, scope, { mode: "history", q: "searchable" }, controller.signal),
    { name: "AbortError" });
  const intact = await queryActivity(index, scope, { mode: "history", kind: "text", limit: 2 });
  assert.equal(intact.blocks.length, 2);
  assert.equal("total" in intact && intact.total, 300);
  await assert.rejects(queryActivity(index, scope, {}, controller.signal), { name: "AbortError" });
}));

test("disk-paged history keeps display order, search totals and late updates without loading every pointer", async () => fixture(async path => {
  const index = await getLogIndex(path), store = index.store("blocks");
  const rows: LogBlock[] = [];
  const total = 5000;
  await index.exclusive(async () => {
    for (let i = 0; i < total; i++) {
      const row: LogBlock = { id: `item-${String(i).padStart(5, "0")}`, kind: i % 11 ? "text" : "diagnostic",
        at: new Date(Date.UTC(2026, 9, 21) + ((i * 97) % total) * 1000).toISOString(), title: "message",
        text: i % 13 ? "ordinary" : "Needle", status: "complete", trace: { epoch: i % 7 ? "cycle" : "other" },
        createdRevision: i + 1, revision: i + 1 };
      rows.push(row);
      await store.put(row.id, row, { at: row.at, epoch: row.trace!.epoch, kind: row.kind, status: row.status,
        createdRevision: row.createdRevision, revision: row.revision });
    }
    index.setMeta("revision", total);
  });
  const expected = rows.filter(row => row.trace!.epoch === "cycle" && row.kind === "text" && row.text === "Needle")
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const first = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", limit: 17 });
  if (!("before" in first)) throw new Error("history cursor missing");
  assert.equal(first.total, expected.length);
  assert.equal(first.projection.blockCount, rows.filter(row => row.trace!.epoch === "cycle").length);
  assert.deepEqual(first.blocks.map(row => row.id), expected.slice(0, 17).reverse().map(row => row.id));
  const second = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", before: first.before!, limit: 17 });
  assert.deepEqual(second.blocks.map(row => row.id), expected.slice(17, 34).reverse().map(row => row.id));
  const snapshot = await queryActivity(index, scope, { limit: 3 });
  if (!("cursor" in snapshot)) throw new Error("snapshot cursor missing");
  const old = expected.at(-1)!;
  const changed = { ...old, text: "late correction", revision: total + 1 };
  await index.exclusive(async () => {
    await store.put(old.id, changed, { at: old.at, epoch: "cycle", kind: old.kind, status: old.status,
      createdRevision: old.createdRevision, revision: changed.revision });
    index.setMeta("revision", changed.revision);
  });
  // Direct lookup and idle/delta polls must not walk all latest records.
  const entries = store.entries;
  store.entries = () => { throw new Error("unexpected full latest scan"); };
  try {
    const delta = await queryActivity(index, scope, { cursor: snapshot.cursor, limit: 1 });
    assert.deepEqual(delta.blocks, [changed]);
    assert.equal(delta.hasMore, false);
    const lookup = await queryActivity(index, scope, { mode: "block", id: old.id });
    assert.deepEqual(lookup.blocks, [changed]);
  } finally { store.entries = entries; }
  const revised = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", limit: 1 });
  assert.equal("total" in revised && revised.total, expected.length - 1);
}));

test("snapshot retains older active blocks with a bounded response for never-finished history", async () => fixture(async path => {
  const index = await getLogIndex(path), store = index.store("blocks");
  await index.exclusive(async () => {
    for (let i = 0; i < 710; i++) {
      const row: LogBlock = { id: `item-${String(i).padStart(3, "0")}`, kind: "tool", title: "tool", text: "",
        at: new Date(Date.UTC(2026, 9, 21) + i * 1000).toISOString(), status: i < 700 ? "running" : "complete",
        revision: i + 1, createdRevision: i + 1 };
      await store.put(row.id, row, { at: row.at, epoch: "cycle", kind: row.kind, status: row.status, revision: row.revision });
    }
    index.setMeta("revision", 710);
  });
  const snapshot = await queryActivity(index, scope, { limit: 3 });
  assert.equal(snapshot.blocks.length, 503);
  assert.equal(snapshot.blocks[0].id, "item-200");
  assert.equal(snapshot.blocks.at(-1)?.id, "item-709");
  assert.equal(snapshot.projection.blockCount, 710);
  const old = await queryActivity(index, scope, { mode: "block", id: "item-000" });
  assert.equal(old.blocks[0].status, "running", "bounded live response never removes historical blocks");
}));
