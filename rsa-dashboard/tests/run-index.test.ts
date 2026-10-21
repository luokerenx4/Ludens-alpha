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
