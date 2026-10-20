import { test } from "node:test";
import assert from "node:assert/strict";
import { getLivePhase } from "../lib/live-phase";
import { parseEvents } from "../lib/aggregate";
import type { Event, LiveStatus } from "../lib/types";

const live: LiveStatus = {
  runId: "run", epoch: "cycle", mode: "auto", connected: true,
  reason: "enabled", agent: true, thinking: true,
};
const event = (type: string, at: number, trace: Record<string, string> = {}, data = {}): Event => ({
  seq: at, at: new Date(at).toISOString(), atMs: at, type,
  trace: { epoch: "cycle", ...trace }, data,
});
const phase = (events: Event[], now = 10000) => getLivePhase(events, "run", "cycle", live, now);

test("live request progresses from preparation through headers and the first stream event", () => {
  const trace = { modelCallId: "model", httpId: "http" };
  const events = [event("model_start", 100, trace)];
  assert.equal(phase(events)?.kind, "prepare");
  events.push(event("model_request", 150, trace));
  assert.equal(phase(events)?.startedAt, new Date(100).toISOString());
  events.push(event("model_http_dispatch", 200, trace));
  assert.equal(phase(events)?.kind, "headers");
  assert.equal(phase(events)?.elapsedMs, 9800);
  events.push(event("model_http_end", 400, trace, { status: 200 }));
  assert.equal(phase(events)?.kind, "first-stream");
  events.push(event("model_stream_start", 500, trace));
  assert.equal(phase(events)?.kind, "stream");
  assert.equal(phase(events)?.elapsedMs, 9500);
  events.push(event("model_end", 600, trace));
  assert.equal(phase(events)?.kind, "idle");
  assert.equal(phase(events)?.elapsedMs, 9400);
});

test("each retry starts a fresh wait; late HTTP and model endings cannot clear it", () => {
  const first = { modelCallId: "model", httpId: "first" };
  const second = { modelCallId: "model", httpId: "second" };
  const events = [
    event("model_start", 100, first),
    event("model_http_dispatch", 200, first),
    event("model_http_error", 300, first),
  ];
  assert.equal(phase(events)?.kind, "idle");
  events.push(event("model_request", 400, second));
  assert.equal(phase(events)?.kind, "prepare");
  events.push(
    event("model_http_dispatch", 500, second),
    event("model_http_end", 600, first, { status: 200 }),
    event("model_stream_start", 700, first),
    event("model_end", 800, { modelCallId: "older-model" }),
  );
  assert.equal(phase(events)?.kind, "headers");
  assert.equal(phase(events)?.elapsedMs, 9500);
  assert.equal(phase(events)?.sourceSeq, 500);
  events.push(event("model_http_end", 900, second, { status: 429 }));
  assert.equal(phase(events)?.kind, "idle");
});

test("commands, captures and observation processing are nested and joined by their own IDs", () => {
  const tool = { modelCallId: "model", toolCallId: "tool" };
  const oldCapture = { ...tool, operationId: "old-capture" };
  const capture = { ...tool, operationId: "capture" };
  const events = [event("tool_start", 100, tool), event("exec", 200, tool)];
  assert.equal(phase(events)?.kind, "command");
  events.push(event("exec_result", 300, tool));
  assert.equal(phase(events)?.kind, "tool");
  events.push(event("observation_start", 400, oldCapture));
  events.push(event("observation_start", 500, capture));
  events.push(event("observation_end", 600, oldCapture, { observations: ["old"] }));
  events.push(event("observation_media", 700, tool, { observationId: "old" }));
  assert.equal(phase(events)?.kind, "capture");
  assert.equal(phase(events)?.sourceSeq, 500);
  events.push(event("observation_end", 800, capture, { observations: ["a", "b"] }));
  assert.equal(phase(events)?.label, "整理观测");
  events.push(event("observation_media", 900, tool, { observationId: "a" }));
  assert.equal(phase(events)?.kind, "observation");
  events.push(event("observation_media", 950, { ...tool, modelCallId: "older" }, { observationId: "b" }));
  assert.equal(phase(events)?.kind, "observation");
  events.push(event("observation_context", 1000, tool, { observations: ["a", "b"] }));
  assert.equal(phase(events)?.kind, "tool");
  events.push(event("tool_end", 1100, tool));
  assert.equal(phase(events)?.kind, "idle");
});

test("perception reads retain their own wait across unrelated late completions", () => {
  const first = { traceId: "perception", spanId: "one" };
  const second = { traceId: "perception", spanId: "two" };
  const events = [
    event("perception_observe_start", 100, first),
    event("perception_observe_start", 200, second),
    event("perception_observe_end", 300, first),
  ];
  assert.equal(phase(events)?.kind, "perception");
  assert.equal(phase(events)?.sourceSeq, 200);
  events.push(event("perception_observe_end", 400, second));
  assert.equal(phase(events)?.kind, "idle");
});

test("reused tool IDs and old epoch cleanup do not finish the current command", () => {
  const older = { modelCallId: "older", toolCallId: "same" };
  const current = { modelCallId: "current", toolCallId: "same" };
  const events = [
    event("tool_start", 100, older), event("exec", 200, older),
    event("tool_start", 300, current), event("exec", 400, current),
    event("exec_result", 500, older), event("tool_end", 600, older),
    event("exec_result", 700, { ...current, epoch: "older-cycle" }),
    event("tool_end", 800, { ...current, epoch: "older-cycle" }),
  ];
  assert.equal(phase(events)?.kind, "command");
  assert.equal(phase(events)?.sourceSeq, 400);
  assert.equal(phase(events)?.elapsedMs, 9600);
});

test("native blocking compaction is distinct from concurrent background HTTP", () => {
  const trace = { modelCallId: "model", httpId: "http" };
  const events = [
    event("model_start", 100, trace), event("model_http_dispatch", 200, trace),
    event("compaction_http_start", 300, { httpId: "background" }),
    event("compaction_http_end", 400, { httpId: "background" }, { status: 200 }),
  ];
  assert.equal(phase(events)?.kind, "headers");
  assert.equal(phase(events)?.sourceSeq, 200);
  events.push(event("auto_compaction_start", 500));
  assert.equal(phase(events)?.kind, "compaction");
  events.push(event("compaction_http_error", 600, { httpId: "background" }));
  assert.equal(phase(events)?.sourceSeq, 500);
  events.push(event("auto_compaction_end", 700));
  assert.equal(phase(events)?.kind, "headers");
  assert.equal(phase([event("auto_compaction_start", 100)])?.kind, "compaction");
});

test("overlapping native compactions cannot fabricate a known start without an operation ID", () => {
  const events = [event("auto_compaction_start", 100), event("auto_compaction_start", 200)];
  events.push(event("auto_compaction_end", 300));
  assert.equal(phase(events)?.kind, "compaction");
  assert.equal(phase(events)?.elapsedMs, null);
  assert.equal(phase(events)?.startedAt, null);
  events.push(event("auto_compaction_end", 400));
  assert.equal(phase(events)?.kind, "idle");
});

test("manual, disconnected, historical run or historical epoch never has a live timer", () => {
  const events = [event("auto_compaction_start", 100)];
  for (const status of [
    null,
    { ...live, mode: "manual" },
    { ...live, connected: false },
    { ...live, runId: "another-run" },
    { ...live, epoch: "new-cycle" },
  ]) assert.equal(getLivePhase(events, "run", "cycle", status), null);
  assert.equal(getLivePhase(events, "run", null, live), null);
  assert.equal(phase([]), null);
});

test("serialized event prefixes retain capture, processing and next HTTP boundaries", () => {
  const tool = { modelCallId: "first", toolCallId: "tool", operationId: "capture" };
  const next = { modelCallId: "next", httpId: "http" };
  const entries = [
    event("tool_start", 100, tool),
    event("observation_start", 200, tool),
    event("observation_end", 300, tool, { observations: ["frame"] }),
    event("observation_context", 400, tool, { observations: ["frame"] }),
    event("tool_end", 500, tool),
    event("model_start", 600, next),
    event("model_request", 700, next),
    event("model_http_dispatch", 800, next),
  ];
  const events = parseEvents(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  for (const [seq, kind] of [
    [200, "capture"], [300, "observation"], [400, "tool"],
    [500, "idle"], [700, "prepare"], [800, "headers"],
  ] as const) {
    const prefix = events.filter((event) => event.seq <= seq);
    const now = Date.parse(prefix.at(-1)!.at) + 1000;
    const result = phase(prefix, now);
    assert.equal(result?.kind, kind, `event ${seq}`);
    assert.ok(result!.elapsedMs! >= 1000);
  }
});

test("WS waits from dispatch until the first inbound event without requiring HTTP IDs", () => {
  const trace = { modelCallId: "model", requestId: "ws-request" };
  const events = [
    event("model_start", 100, trace),
    event("model_request", 200, trace, { transport: "websocket", bodyBytes: 9000000, incremental: false }),
  ];
  assert.equal(phase(events)?.kind, "prepare");
  events.push(event("model_ws_dispatch", 300, trace, { bodyBytes: 9000000 }));
  assert.equal(phase(events)?.label, "等待模型首事件");
  assert.equal(phase(events)?.elapsedMs, 9700);
  events.push(event("model_stream_start", 500, { ...trace, requestId: "old-request" }));
  assert.equal(phase(events)?.sourceSeq, 300);
  events.push(event("model_stream_start", 600, trace, { afterDispatchMs: 300 }));
  assert.equal(phase(events)?.kind, "stream");
  assert.equal(phase(events)?.sourceSeq, 600);
  events.push(event("model_end", 900, trace));
  assert.equal(phase(events)?.kind, "idle");
});

test("WS retry and SSE fallback replace only the matching request's live phase", () => {
  const first = { modelCallId: "model", requestId: "first" };
  const retry = { modelCallId: "model", requestId: "retry" };
  const http = { modelCallId: "model", requestId: "fallback", httpId: "http" };
  const events = [
    event("model_start", 100, first),
    event("model_request", 200, first, { transport: "websocket" }),
    event("model_ws_dispatch", 300, first),
    event("model_request", 400, retry, { transport: "websocket" }),
    event("model_ws_dispatch", 500, retry),
    event("model_ws_dispatch", 550, first),
    event("model_stream_start", 600, first),
  ];
  assert.equal(phase(events)?.kind, "ws-first-event");
  assert.equal(phase(events)?.sourceSeq, 500);
  events.push(event("model_request", 700, http));
  assert.equal(phase(events)?.kind, "prepare");
  events.push(event("model_http_dispatch", 800, http));
  events.push(event("model_stream_start", 850, retry));
  assert.equal(phase(events)?.kind, "headers");
  events.push(event("model_http_end", 900, http, { status: 200 }));
  assert.equal(phase(events)?.kind, "first-stream");
  events.push(event("model_stream_start", 1000, http));
  assert.equal(phase(events)?.kind, "stream");
});
