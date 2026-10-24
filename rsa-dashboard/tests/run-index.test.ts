import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogIndex, closeLogIndexes, type LogIndex } from "../lib/log-index";
import { refreshRunProjection, readRunProjection, selectIndexedCycle, indexedObservation } from "../lib/run-index";
import { aggregate, selectCycle } from "../lib/aggregate";
import type { Event, Manifest } from "../lib/types";

function events() {
  let seq = 0;
  return (type: string, data: Record<string, any> = {}, trace: Record<string, string> = {}): Event => ({
    seq: ++seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000, type, data,
    trace: { epoch: "cycle", ...trace }, source: { component: "rsa" },
  });
}
async function fixture(values: Event[], check: (index: LogIndex, path: string) => Promise<void>) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-run-index-")));
  try {
    await writeFile(join(path, "events.jsonl"), values.map(value => JSON.stringify(value)).join("\n") + "\n");
    const index = await getLogIndex(path);
    await refreshRunProjection(index);
    await check(index, path);
  } finally { closeLogIndexes(); await rm(path, { recursive: true, force: true }); }
}

test("incremental action terminals update execution time and counts after an async submission returns", async () => {
  const e = events();
  const trace = { traceId: "trace", spanId: "play", modelCallId: "model" };
  const values = [e("control", { mode: "auto" }), e("model_start", {}, trace),
    e("command", { controllerId: "pad", argv: ["play"] }, trace),
    e("action_start", { actionId: "one", timing: { clock: "driver", submittedAtMs: 100 } }, trace),
    e("execution", { actionId: "one", status: "completed", exitCode: 0, durationMs: 1 }, trace),
  ];
  await fixture(values, async (index, path) => {
    const before = await readRunProjection(index, "cycle");
    assert.equal(before.summary.actions, 0);
    assert.equal(before.telemetry.spans.find(span => span.operation === "play")?.outcome, "pending");
    const after = [e("control", { mode: "manual" }),
      e("action_end", { actionId: "one", status: "completed", exitCode: 0,
        timing: { clock: "driver", requestedAtMs: 100, receivedAtMs: 600 } }, trace),
      e("execution", { actionId: "one", status: "completed", exitCode: 0 }, { ...trace, spanId: "wait" }),
      e("execution", { readOnly: true, status: "completed", exitCode: 0 }, { ...trace, spanId: "state" }),
      e("action_start", { actionId: "failed", timing: { clock: "driver", submittedAtMs: 700 } }, { ...trace, spanId: "failed" }),
      e("action_end", { actionId: "failed", status: "failed", exitCode: 1, error: "bridge disconnected",
        timing: { clock: "driver", requestedAtMs: 700, receivedAtMs: 800 } }, { ...trace, spanId: "failed" }),
    ];
    await appendFile(join(path, "events.jsonl"), after.map(value => JSON.stringify(value)).join("\n") + "\n");
    await refreshRunProjection(index);
    const result = await readRunProjection(index, "cycle");
    assert.equal(result.summary.actions, 1);
    assert.equal(result.calls[0].actions, 1);
    assert.equal(result.summary.errors, 1);
    assert.equal(result.telemetry.spans.find(span => span.operation === "play" && span.spanId === "play")?.durationMs, 500);
    assert.equal(result.telemetry.spans.find(span => span.operation === "execute" && span.spanId === "play")?.durationMs, 1);
    assert.equal(result.summary.actions, aggregate([...values, ...after]).summary.actions);
  });
});

test("run pages read 100 requests and retain whole-cycle metrics and off-page deep links", async () => {
  const event = events(), values = [event("control", { mode: "auto" })];
  for (let i = 1; i <= 205; i++) values.push(
    event("model_start", {}, { modelCallId: `call-${i}` }),
    event("model_request", { transport: "websocket" }, { modelCallId: `call-${i}` }),
    event("model_stream_start", { afterDispatchMs: i }, { modelCallId: `call-${i}` }),
    event("model_end", { durationMs: i * 100, stopReason: "stop", usage: { input: 10, cacheRead: 90 } }, { modelCallId: `call-${i}` }),
  );
  values.push(event("control", { mode: "manual" }));
  await fixture(values, async index => {
    const latest = await readRunProjection(index, "cycle", { call: "call-3" });
    assert.equal(latest.calls.length, 100);
    assert.deepEqual(latest.paging, { totalCalls: 205, beforeCall: 106, hasMore: true, firstIndex: 106, lastIndex: 205 });
    assert.equal(latest.selectedCall?.index, 3);
    assert.equal(latest.summary.completed, 205);
    assert.equal(latest.summary.medianWsWaitMs, 103);
    assert.equal(latest.summary.medianMs, aggregate(values).summary.medianMs);
    assert.equal(latest.summary.cacheHit, .9);
    const older = await readRunProjection(index, "cycle", { beforeCall: latest.paging.beforeCall! });
    const first = await readRunProjection(index, "cycle", { beforeCall: older.paging.beforeCall! });
    assert.deepEqual([...first.calls, ...older.calls, ...latest.calls].map(call => call.index), Array.from({ length: 205 }, (_, i) => i + 1));
    assert.equal(first.paging.hasMore, false);
    assert.equal(first.summary.completed, 205);
  });
});

test("incremental projection retains actual perception input, late results and epoch isolation", async () => {
  const event = events(), trace = { modelCallId: "one", traceId: "trace", spanId: "native" };
  const values = [
    event("perception_status", { state: "ready", generation: "python" }, { epoch: "" }),
    event("control", { mode: "auto" }),
    event("perception_observe_end", { status: { state: "ready", generation: "python" }, result: {
      id: "input", status: "completed", exitCode: 0, stdout: "fused pixels", observations: [
        { id: "fusion", controllerId: "perception", mediaType: "image/png", path: "/frame.png" },
      ],
    } }),
    event("context", { observations: ["fusion"], executions: ["input"] }),
    event("shiori_span_start", { name: "native" }, trace),
    event("model_start", { observations: ["fusion"] }, trace),
    event("tool_start", { toolName: "read", args: { path: "skills/jump/SKILL.md" } }, { ...trace, toolCallId: "read" }),
    event("model_end", { durationMs: 100, stopReason: "stop" }, trace),
    event("control", { mode: "manual" }),
    event("control", { mode: "auto" }, { epoch: "next" }),
    event("model_start", {}, { epoch: "next", modelCallId: "two" }),
  ];
  await fixture(values, async (index, path) => {
    const before = await readRunProjection(index, "cycle");
    assert.equal(before.calls[0].inputText, "fused pixels");
    assert.equal(before.observations[0].origin, "perception");
    assert.equal(before.observations[0].text, "fused pixels");
    assert.equal(before.skills[0].ok, null);
    assert.equal(before.telemetry.shiori.stats.outcomes.pending, 1);
    const appended = [event("tool_end", { isError: false }, { ...trace, toolCallId: "read" }),
      event("shiori_span_end", { outcome: "success", durationMs: 42 }, trace),
      event("execution", { status: "completed", exitCode: 0 }),
    ];
    await appendFile(join(path, "events.jsonl"), appended.map(value => JSON.stringify(value)).join("\n") + "\n");
    await refreshRunProjection(index);
    const after = await readRunProjection(index, "cycle");
    assert.equal(after.calls.length, 1);
    assert.equal(after.skills[0].ok, true);
    assert.equal(after.telemetry.shiori.stats.outcomes.success, 1);
    assert.equal(after.summary.actions, 1);
    assert.equal((await readRunProjection(index, "next")).summary.actions, 0);
    assert.equal((await readRunProjection(index, "next")).calls[0].id, "two");
    assert.equal((await indexedObservation(index, "fusion"))?.path, "/frame.png");
    const cycle = await selectIndexedCycle(index, {} as Manifest);
    assert.equal(cycle.selectedEpoch, "next");
    await assert.rejects(selectIndexedCycle(index, {} as Manifest, "absent"), /周期/);
    const expected = aggregate(selectCycle([...values, ...appended], "cycle").events);
    assert.deepEqual(after.calls, JSON.parse(JSON.stringify(expected.calls)));
    assert.deepEqual(after.observations, JSON.parse(JSON.stringify(expected.observations)));
    for (const key of Object.keys(expected.summary)) assert.equal(after.summary[key as keyof typeof after.summary], expected.summary[key as keyof typeof expected.summary], key);
  });
});

test("late controller errors replace sampling notices instead of double-counting failure", async () => {
  const event = events(), trace = { traceId: "trace", spanId: "device" };
  const values = [event("control", { mode: "auto" }), event("observation_error", { error: "sample failed" }, trace)];
  await fixture(values, async (index, path) => {
    assert.equal((await readRunProjection(index, "cycle")).summary.errors, 1);
    await appendFile(join(path, "events.jsonl"), JSON.stringify(event("execution_error", { error: "device failed" }, trace)) + "\n");
    await refreshRunProjection(index);
    const result = await readRunProjection(index, "cycle");
    assert.equal(result.summary.errors, 1);
    assert.equal(result.notices[0].type, "execution_error");
  });
});

test("concurrent readers share one refresh and later appends remain visible", async () => {
  const event = events();
  await fixture([event("control", { mode: "auto" })], async (index, path) => {
    const append = () => appendFile(join(path, "events.jsonl"),
      JSON.stringify(event("execution", { status: "completed", exitCode: 0 })) + "\n");
    await append();
    const readers = Array.from({ length: 10 }, () => refreshRunProjection(index));
    assert.ok(readers.every(pending => pending === readers[0]));
    await Promise.all(readers);
    assert.equal((await readRunProjection(index, "cycle")).summary.actions, 1);
    await append();
    await refreshRunProjection(index);
    assert.equal((await readRunProjection(index, "cycle")).summary.actions, 2);
  });
});

test("paged telemetry keeps the selected call's descendants and ancestors without unrelated trace siblings", async () => {
  const event = events();
  const trace = (spanId: string, extra: Record<string, string> = {}) => ({ traceId: "shared", spanId, ...extra });
  const values = [event("control", { mode: "auto" }),
    event("shiori_span_start", { name: "root" }, trace("root")),
    event("shiori_span_start", { name: "call" }, trace("call", { parentSpanId: "root", modelCallId: "model" })),
    event("model_start", {}, trace("call", { parentSpanId: "root", modelCallId: "model" })),
    event("capability_start", { name: "child" }, trace("child", { parentSpanId: "call" })),
    event("command", { controllerId: "pad.play", arguments: {} }, trace("grandchild", { parentSpanId: "child" })),
    event("execution", { outcome: "success", exitCode: 0, durationMs: 7 }, trace("grandchild", { parentSpanId: "child" })),
    event("capability_end", { outcome: "success", durationMs: 11 }, trace("child", { parentSpanId: "call" })),
  ];
  for (let i = 0; i < 50; i++) values.push(
    event("command", { controllerId: "screen.capture", arguments: {} }, trace(`sibling-${i}`, { parentSpanId: "root" })),
    event("execution", { outcome: "success", readOnly: true, exitCode: 0, durationMs: i + 1 }, trace(`sibling-${i}`, { parentSpanId: "root" })),
  );
  values.push(event("model_end", { durationMs: 50, stopReason: "stop" }, trace("call", { modelCallId: "model" })),
    event("shiori_span_end", { outcome: "success", durationMs: 55 }, trace("call")),
    event("shiori_span_end", { outcome: "success", durationMs: 60 }, trace("root")));
  await fixture(values, async index => {
    const actual = await readRunProjection(index, "cycle");
    assert.deepEqual(actual.telemetry.spans.map(span => span.spanId).sort(), ["call", "child", "grandchild", "root"]);
    assert.equal(actual.telemetry.devices.started, 51);
    assert.equal(actual.telemetry.devices.durationMs.median, 25);
    assert.equal(actual.telemetry.devices.durationMs.p95, 48);
    assert.equal(actual.telemetry.devices.outcomes.success, 51);
  });
});

test("image lookup uses epoch keys and still selects the latest archive across cycles", async () => {
  const event = events();
  const capture = (path: string) => ({ status: { state: "ready" }, result: {
    id: path, status: "completed", exitCode: 0, observations: [
      { id: "shared-image", controllerId: "perception", mediaType: "image/png", path },
    ],
  } });
  await fixture([
    event("perception_observe_end", capture("/old.png")),
    event("perception_observe_end", capture("/new.png"), { epoch: "next" }),
  ], async index => {
    const store = index.store("run-observations"), entries = store.entries;
    store.entries = () => { throw new Error("Image lookup must not scan all recorded frames"); };
    try { assert.equal((await indexedObservation(index, "shared-image"))?.path, "/new.png"); }
    finally { store.entries = entries; }
  });
});
