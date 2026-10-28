import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogIndex } from "../lib/log-index";
import { captureSources } from "../lib/cold-source";
import { createRunReducer, readRunProjection, refreshRunProjection } from "../lib/run-index";
import { createActivityReducer, queryActivity, refreshActivity } from "../lib/activity";

function facts() {
  let seq = 0;
  return (type: string, data: Record<string, any> = {}, trace: Record<string, string> = {}): Event => ({
    seq: ++seq, type, data, trace: { epoch: "cycle", ...trace },
    at: new Date(seq * 1000).toISOString(), atMs: seq * 1000, source: { component: "rsa" },
  });
}
import type { Event } from "../lib/types";
const wire = (delta: string) => JSON.stringify({ atMs: 1, event: { type: "response.output_text.delta",
  item_id: "answer", delta } }) + "\n";

test("one source feed builds latest cold Activity recipes at fixed cutoffs, then appends preserve delivered versions", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-reducers-")));
  const index = new LogIndex(path, join(path, "index"));
  try {
    const e = facts(), model = { modelCallId: "model" }, python = { traceId: "python", spanId: "root" };
    const values = [e("control", { mode: "auto" }), e("context", { observations: [] }),
      e("model_start", {}, model), e("python_call_start", { id: "outer" }, python)];
    for (let i = 0; i < 12; i++) {
      const child = { ...python, spanId: `child-${i}`, parentSpanId: "root" };
      values.push(e("python_call_start", { id: "inner" }, child), e("python_call_end", { id: "inner", outcome: "success" }, child));
    }
    values.push(e("python_call_end", { id: "outer", outcome: "success" }, python),
      e("model_request", { transport: "websocket" }, model), e("model_stream_start", { afterDispatchMs: 12 }, model));
    await mkdir(join(path, "streams"));
    await writeFile(join(path, "streams/model.jsonl"), wire("before"));
    await writeFile(join(path, "events.jsonl"), values.map(row => JSON.stringify(row)).join("\n") + "\n");
    const source = await captureSources(path);
    // Neither file's append belongs to the captured directory generation.
    const end = e("model_end", { durationMs: 123, stopReason: "stop", usage: { input: 5, cacheRead: 15 } }, model);
    await appendFile(join(path, "events.jsonl"), JSON.stringify(end) + "\n");
    await appendFile(join(path, "streams/model.jsonl"), wire(" after"));
    index.setSourceSnapshot(source.snapshot); index.beginBulk(2 * 1024 ** 2);
    const run = await createRunReducer(index, { cold: true });
    const activity = await createActivityReducer(index, { cold: true,
      streamLimits: new Map([["streams/model.jsonl", source.snapshot["streams/model.jsonl"]!.size]]) });
    let fed = 0;
    const read = index.readEvent.bind(index); let reads = 0;
    index.readEvent = async value => { reads++; return read(value); };
    await index.bulkEvents({ onEvent: async (event, position) => {
      await run.feed({ event, position }); await activity.feed({ event, position }); fed++;
    } });
    assert.equal(fed, values.length);
    assert.equal(reads, 0, "feed never reloads source groups or Python roots");
    await run.finish(); await activity.finish(); index.finishBulk(); index.flush();
    const rows = [...index.store("blocks").entries()], versions = [...index.store("blocks").versions({ after: 0 })];
    assert.equal(versions.length, rows.length, "cold build publishes one final version per block");
    assert.equal(new Set(versions.map(row => row.revision)).size, rows.length);
    assert.deepEqual(versions.map(row => row.revision).sort((a, b) => Number(a) - Number(b)), Array.from({ length: rows.length }, (_, i) => i + 1));
    const scope = { project: "fixture", runId: "run", epoch: "cycle" };
    const snapshot = await queryActivity(index, scope);
    assert.equal(snapshot.blocks.find(block => block.kind === "text")?.text, "before");
    assert.equal(snapshot.blocks.find(block => block.id.startsWith("python:"))?.data?.calls, 13);
    assert.equal((await readRunProjection(index, "cycle")).summary.completed, 0);
    const cursor = "cursor" in snapshot ? snapshot.cursor : undefined;
    index.setSourceSnapshot(undefined);
    await refreshRunProjection(index); await refreshActivity(index);
    const delta = await queryActivity(index, scope, { cursor: cursor ?? undefined });
    assert.equal(delta.mode, "delta");
    assert.equal(delta.blocks.find(block => block.kind === "text")?.text, "before after");
    assert.equal((await readRunProjection(index, "cycle")).summary.completed, 1);
    // Immutable pre-append revision still points at the earlier source cutoffs.
    const text = rows.find(row => row.kind === "text")!;
    const oldVersion = [...index.store("blocks").versions({ after: Number(text.revision) - 1, before: Number(text.revision) + 1 })];
    assert.equal(oldVersion[0]?.recipe.streamOffset, source.snapshot["streams/model.jsonl"]!.size);
    assert.equal(oldVersion[0]?.recipe.eventCutoff, values.length);
  } finally { index.close(); await rm(path, { recursive: true, force: true }); }
});

test("run reducer restores only explicit endpoints when a completed span gains a late model identity", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-reducer-late-")));
  const index = new LogIndex(path, join(path, "index"));
  try {
    const e = facts(), trace = { traceId: "t", spanId: "s" };
    const values = [e("control", { mode: "auto" }),
      e("shiori_span_end", { outcome: "success", durationMs: 42 }, trace),
      e("shiori_span_start", {}, trace), e("context", { observations: [] }),
      e("model_start", {}, { ...trace, modelCallId: "m" }),
      e("model_end", { durationMs: 12, stopReason: "stop" }, { modelCallId: "m" })];
    const run = await createRunReducer(index, { cold: true });
    const restored: number[] = [];
    index.readEvent = async value => { const position = typeof value === "number" ? value : value.position;
      restored.push(position); return values[position - 1]; };
    index.queryEvents = async () => { throw new Error("feed must not scan a group"); };
    for (const [n, event] of values.entries()) await run.feed({ event, position: n + 1 });
    await run.finish();
    const spans = [...index.store("run-spans").entries()];
    assert.equal(spans.length, 1); assert.equal(spans[0]!.outcome, "success");
    assert.equal(spans[0]!.duration, 42); assert.equal(spans[0]!.model, "m");
    assert.equal(index.store("run-starts").meta("m")?.position, 5);
    assert.equal(index.store("run-calls").meta("m")?.completed, true);
    assert.deepEqual(restored, [2, 3], "only the completed span's two endpoints are read for the late join");
    const recipe = [...index.store("run-span-state").entries()][0]!.recipe;
    assert.deepEqual(recipe.starts, { shiori_span_start: 3 });
    assert.deepEqual(recipe.ends, { shiori_span_start: 2 });
    assert.equal(JSON.stringify(recipe).includes("atMs"), false, "event clocks are read from their unique source");
    // A relation-only recipe can also precede its start; its business ID must survive restoration.
    const resumed = await createRunReducer(index);
    await resumed.feed({ event: e("model_start", {}, { traceId: "ahead", spanId: "ahead", modelCallId: "ahead-model" }), position: 7 });
    await resumed.feed({ event: e("shiori_span_start", {}, { traceId: "ahead", spanId: "ahead" }), position: 8 });
    await resumed.finish();
    assert.equal([...index.store("run-spans").entries()].find(row => row.span === "ahead")?.model, "ahead-model");
  } finally { index.close(); await rm(path, { recursive: true, force: true }); }
});
