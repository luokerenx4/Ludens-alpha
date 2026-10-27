import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

test("a new activity reader does not inherit the departed reader's cancellation", async () => fixture(async path => {
  const index = getLogIndex(path);
  await index.refreshEvents();
  let unblock!: () => void;
  const gate = index.exclusive(() => new Promise<void>(resolve => { unblock = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const old = refreshActivity(index, { ingest: false, signal: controller.signal });
  const rejected = assert.rejects(old, { name: "AbortError" });
  controller.abort();
  const fresh = refreshActivity(index, { ingest: false });
  assert.notEqual(fresh, old);
  unblock(); await gate; await rejected; await fresh;
  const result = await queryActivity(index, scope);
  assert.ok(result.blocks.some(block => block.title === "control"));
}));

test("Python groups survive page boundaries, restart and late outer completion without losing raw exceptions", async () => fixture(async path => {
  const local = (seq: number, type: string, spanId: string, parentSpanId?: string, outcome?: string): Event => ({
    ...event(seq, type, { id: `python/run.py:${spanId}`, outcome, ...(outcome === "error" ? { error: "expected failure" } : {}) }),
    trace: { epoch: "cycle", traceId: "trace", spanId, ...(parentSpanId ? { parentSpanId } : {}) },
  });
  const append = async (events: Event[]) => appendFile(join(path, "events.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  let index = getLogIndex(path);
  await append([local(3, "python_call_start", "outer")]); await refreshActivity(index);
  const initial = await queryActivity(index, scope);
  await closeLogIndexes(); index = getLogIndex(path);
  await append([local(4, "python_call_start", "inner", "outer"), local(5, "python_call_end", "inner", "outer", "error")]);
  await refreshActivity(index);
  await append([local(6, "python_call_end", "outer", undefined, "success")]); await refreshActivity(index);
  const diagnostic = await queryActivity(index, scope, { mode: "history", kind: "diagnostic", q: "trace" });
  const group = diagnostic.blocks.find(block => block.id.startsWith("python:"))!;
  assert.equal(diagnostic.blocks.filter(block => block.id.startsWith("python:")).length, 1);
  assert.deepEqual([group.data?.calls, group.data?.raised, group.data?.pending, group.data?.rootOutcome], [2, 1, 0, "success"]);
  assert.equal(group.status, "complete"); assert.equal(group.outcome, "raised");
  assert.equal(diagnostic.blocks.filter(block => block.title === "python_call_end").length, 2);
  const delta = await queryActivity(index, scope, { cursor: initial.cursor! });
  assert.ok(delta.blocks.some(block => block.id === group.id && block.data?.rootOutcome === "success"));
  await refreshActivity(index);
  const again = await queryActivity(index, scope, { mode: "block", id: group.id });
  assert.deepEqual(again.blocks[0].data, group.data, "re-reading must not count calls again");
}));

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

test("source-backed history keeps paging, searches and immutable late updates without persisted bodies", async () => fixture(async path => {
  const index = getLogIndex(path), total = 5000;
  const source = Array.from({ length: total }, (_, i) => ({ id: `item-${String(i).padStart(5, "0")}`,
    atMs: ((i * 97) % total) * 1000, epoch: i % 7 ? "cycle" : "other", text: i % 13 ? "ordinary" : "Needle" }));
  const frameFor = (value: typeof source[number], sequence: number, text = value.text) => JSON.stringify({
    atMs: value.atMs, trace: { epoch: value.epoch }, event: { data: JSON.stringify({ type: "response.output_text.done",
      item_id: value.id, text, sequence_number: sequence }) } }) + "\n";
  await writeFile(join(path, "streams/model.jsonl"), source.map((row, i) => frameFor(row, i + 1)).join(""));
  await refreshActivity(index);
  const expected = source.filter(row => row.epoch === "cycle" && row.text === "Needle")
    .sort((a, b) => b.atMs - a.atMs || b.id.localeCompare(a.id));
  const first = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", limit: 17 });
  if (!("before" in first)) throw new Error("history cursor missing");
  assert.equal(first.total, expected.length);
  assert.deepEqual(first.blocks.map(row => row.id), expected.slice(0, 17).reverse().map(row => `model:text:${row.id}:0`));
  const second = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", before: first.before!, limit: 17 });
  assert.deepEqual(second.blocks.map(row => row.id), expected.slice(17, 34).reverse().map(row => `model:text:${row.id}:0`));
  const snapshot = await queryActivity(index, scope, { limit: 3 });
  const old = expected.at(-1)!;
  await appendFile(join(path, "streams/model.jsonl"), frameFor(old, total + 1, "late correction"));
  await refreshActivity(index);
  const store = index.store("blocks"), entries = store.entries;
  store.entries = () => { throw new Error("unexpected full latest scan"); };
  try {
    const delta = await queryActivity(index, scope, { cursor: snapshot.cursor!, limit: 1 });
    assert.equal(delta.blocks[0].id, `model:text:${old.id}:0`); assert.equal(delta.blocks[0].text, "late correction");
    const lookup = await queryActivity(index, scope, { mode: "block", id: `model:text:${old.id}:0` });
    assert.equal(lookup.blocks[0].text, "late correction");
  } finally { store.entries = entries; }
  const revised = await queryActivity(index, scope, { mode: "history", kind: "text", q: "needle", limit: 1 });
  assert.equal("total" in revised && revised.total, expected.length - 1);
  for (const name of ["blocks", "streams", "events", "relations"])
    assert.ok((await readdir(join(index.directory, name))).every(file => !file.startsWith("data-")), `${name} stores only locators`);
}));

test("snapshot retains older active tools while its response stays bounded", async () => fixture(async path => {
  const index = getLogIndex(path);
  await writeFile(join(path, "streams/model.jsonl"), Array.from({ length: 710 }, (_, i) =>
    frame(`response.function_call_arguments.${i < 700 ? "delta" : "done"}`, `item-${String(i).padStart(3, "0")}`, "", i + 1)).join(""));
  await refreshActivity(index);
  const snapshot = await queryActivity(index, scope, { limit: 3 });
  assert.equal(snapshot.blocks.length, 503);
  assert.equal(snapshot.blocks[0].id, "model:tool:item-200");
  assert.equal(snapshot.blocks.at(-1)?.id, "model:tool:item-709");
  const old = await queryActivity(index, scope, { mode: "block", id: "model:tool:item-000" });
  assert.equal(old.blocks[0].status, "running", "bounded live response never removes historical blocks");
}));

test("activity can commit bounded batches and resume without copying ordinary diagnostic payloads", async () => fixture(async path => {
  const index = getLogIndex(path);
  const events = Array.from({ length: 1200 }, (_, i) => ({ ...event(i + 3, "perception_sample", { evidence: "large raw evidence ".repeat(100) }), trace: { epoch: "cycle" } }));
  await appendFile(join(path, "events.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  await refreshActivity(index, { maxEvents: 100 });
  assert.equal(Number(index.meta("activityPosition")), 100);
  await refreshActivity(index);
  const page = await queryActivity(index, scope, { mode: "history", kind: "diagnostic", q: "large raw evidence", limit: 2 });
  assert.equal("total" in page && page.total, 1200);
  assert.ok(page.blocks.every(block => block.data?.evidence === events[0].data.evidence));
  const names = await readdir(join(index.directory, "blocks", "pages"));
  for (const name of names.filter(name => name.endsWith(".jsonl")))
    assert.equal((await readFile(join(index.directory, "blocks", "pages", name), "utf8")).includes("large raw evidence"), false);
}));
