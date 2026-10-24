import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, selectCycle } from "../lib/aggregate";
import { p95, projectTelemetry } from "../lib/telemetry";
import type { Event } from "../lib/types";

function fixture() {
  let seq = 0;
  return (
    type: string,
    spanId: string,
    data: Record<string, unknown> = {},
    trace: Record<string, string> = {},
  ): Event => ({
    seq: ++seq,
    at: new Date(seq * 1000).toISOString(),
    atMs: seq * 1000,
    type,
    data,
    trace: { epoch: "old", traceId: "trace", spanId, ...trace },
    source: { component: type.startsWith("shiori") ? "shiori" : "rsa" },
  });
}

test("async play has a distinct execution lifetime and submission/query RPCs are not extra actions", () => {
  const e = fixture();
  const events = [
    e("command", "play", { controllerId: "pad", argv: ["play"] }),
    e("action_start", "play", { actionId: "movement", status: "running", timing: { clock: "baseware", submittedAtMs: 10 } }),
    e("execution", "play", { actionId: "movement", status: "completed", exitCode: 0, durationMs: 2 }),
    e("command", "query", { controllerId: "pad", argv: ["status", "--action", "movement"] }),
    e("execution", "query", { actionId: "movement", status: "completed", exitCode: 0 }),
    e("action_end", "play", { actionId: "movement", status: "completed", exitCode: 0,
      timing: { clock: "baseware", requestedAtMs: 10, receivedAtMs: 510 } }),
    e("command", "wait", { controllerId: "pad", argv: ["wait", "--action", "movement"] }),
    e("execution", "wait", { actionId: "movement", status: "completed", exitCode: 0 }),
    e("execution", "state", { readOnly: true, status: "completed", exitCode: 0 }),
    e("action_start", "cancelled", { actionId: "cancelled", timing: { clock: "baseware", submittedAtMs: 600 } }),
    e("action_end", "cancelled", { actionId: "cancelled", status: "interrupted", exitCode: 130,
      timing: { clock: "baseware", requestedAtMs: 600, receivedAtMs: 650 } }),
  ];
  const result = projectTelemetry(events);
  const played = result.spans.filter(span => span.operation === "play");
  assert.deepEqual(played.map(span => [span.outcome, span.durationMs]), [["success", 500], ["cancelled", 50]]);
  assert.equal(result.spans.find(span => span.spanId === "play" && span.operation === "execute")?.durationMs, 2);
  assert.equal(new Set(result.spans.map(span => span.id)).size, result.spans.length);
  assert.equal(aggregate(events).summary.actions, 1);
});

test("trace projection preserves nested and concurrent capability identities without double-counting Python details", () => {
  const e = fixture();
  const events = [
    e("shiori_span_start", "tool", { operation: "execute_tool", name: "exec" }),
    e(
      "tool_start",
      "tool",
      { toolName: "exec" },
      { modelCallId: "model", toolCallId: "tool-call" },
    ),
    e(
      "capability_start",
      "one",
      { id: "python/drive", action: "call" },
      { parentSpanId: "tool" },
    ),
    e(
      "python_capability",
      "one",
      { capabilityId: "python/drive", codeSHA: "version-a" },
      { parentSpanId: "tool" },
    ),
    e(
      "capability_start",
      "two",
      { id: "python/drive", action: "call" },
      { parentSpanId: "tool" },
    ),
    e(
      "capability_start",
      "nested",
      { id: "controller/gamepad", action: "call" },
      { parentSpanId: "one" },
    ),
    e("capability_end", "two", {
      outcome: "error",
      durationMs: 10,
      error: "rejected",
    }),
    e("capability_end", "nested", { outcome: "success", durationMs: 20 }),
    e("python_capability_result", "one", {
      outcome: "success",
      durationMs: 40,
    }),
    e("capability_end", "one", { outcome: "success", durationMs: 50 }),
    e("shiori_span_end", "tool", { outcome: "success", durationMs: 60 }),
  ];
  const result = projectTelemetry(events);
  assert.equal(result.capabilities.stats.started, 3);
  assert.equal(result.capabilities.stats.outcomes.success, 2);
  assert.equal(result.capabilities.stats.outcomes.error, 1);
  assert.deepEqual(result.capabilities.stats.durationMs, {
    median: 20,
    p95: 50,
  });
  assert.equal(result.capabilities.python.started, 1);
  assert.equal(
    result.spans.find((span) => span.spanId === "nested")?.parentSpanId,
    "one",
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "tool")?.modelCallId,
    "model",
  );
  assert.equal(
    result.spans.find((span) => span.kind === "python")?.codeSHA,
    "version-a",
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "two")?.error,
    "rejected",
  );
  assert.equal(
    new Set(result.spans.map((span) => span.id)).size,
    result.spans.length,
  );
});

test("workspace Python calls preserve their own nested spans, source clock and late endings", () => {
  const e = fixture();
  const local = (type: string, spanId: string, data: Record<string, unknown> = {}, trace: Record<string, string> = {}): Event => ({
    ...e(type, spanId, { id: "python/actions.py:step", codeSHA: "loaded-code", pid: 42, ...data }, trace),
    source: { component: "workspace", implementation: "python" },
    origin: { clockId: "python-42", eventId: type + spanId, seq: 1, at: "2026-10-20T00:00:00.000Z", atMs: 100 },
  });
  const events = [
    e("control", "", { mode: "auto" }),
    e("python_capability", "runner", { capabilityId: "python/actions.py:step" }, { parentSpanId: "tool" }),
    local("python_call_start", "outer", {}, { parentSpanId: "runner" }),
    local("python_call_start", "inner", {}, { parentSpanId: "outer" }),
    e("command", "device", { controllerId: "pad" }, { parentSpanId: "inner" }),
    e("execution", "device", { outcome: "success", durationMs: 1 }),
    local("python_call_end", "inner", { outcome: "success", durationMs: 5 }),
    e("control", "", { mode: "manual" }),
    e("control", "", { mode: "auto" }, { epoch: "new" }),
    local("python_call_start", "outer", {}, { epoch: "new", parentSpanId: "runner" }),
    local("python_call_end", "outer", { outcome: "cancelled", durationMs: 10, error: "cancelled" }),
    e("python_capability_result", "runner", { outcome: "cancelled", durationMs: 12 }),
  ];
  const result = projectTelemetry(selectCycle(events, "old").events, events);
  assert.equal(result.capabilities.python.started, 1);
  assert.equal(result.capabilities.localPython.started, 2);
  assert.equal(result.capabilities.localPython.outcomes.cancelled, 1);
  assert.equal(result.capabilities.localPython.durationMs.median, 7.5);
  assert.equal(result.devices.started, 1);
  const outer = result.spans.find(span => span.kind === "python-local" && span.spanId === "outer")!;
  assert.equal(outer.parentSpanId, "runner");
  assert.equal(outer.codeSHA, "loaded-code");
  assert.equal(outer.startedAt, "2026-10-20T00:00:00.000Z");
  assert.equal(outer.endedAt, outer.startedAt);
  assert.equal(outer.error, "cancelled");
  assert.equal(outer.source?.component, "workspace");
  assert.equal(result.spans.find(span => span.spanId === "inner")?.parentSpanId, "outer");
  assert.equal(result.spans.find(span => span.spanId === "device")?.parentSpanId, "inner");
  const next = projectTelemetry(selectCycle(events, "new").events, events);
  assert.equal(next.capabilities.localPython.outcomes.pending, 1);
  assert.equal(next.capabilities.localPython.durationMs.median, null);
});

test("epoch selection includes late terminals and native summaries only for the selected loop", () => {
  const e = fixture();
  const events = [
    e("control", "", { mode: "auto" }),
    e("shiori_span_start", "loop", { operation: "invoke_agent" }),
    e("capability_start", "call", { id: "python/repeat", action: "call" }),
    e("control", "", { mode: "manual" }),
    e("control", "", { mode: "auto" }, { epoch: "new" }),
    e(
      "shiori_span_start",
      "loop",
      { operation: "invoke_agent" },
      { epoch: "new" },
    ),
    e(
      "capability_start",
      "call",
      { id: "python/repeat", action: "call" },
      { epoch: "new" },
    ),
    e("capability_end", "call", { outcome: "cancelled", durationMs: 42 }),
    e("shiori_span_end", "loop", { outcome: "cancelled", durationMs: 50 }),
    e("shiori_run_end", "loop", {
      summary: { stepCount: 7 },
      coverage: { toolsInvoked: ["exec"] },
    }),
    e("shiori_run_end", "unstarted", { summary: { stepCount: 99 } }),
  ];
  const old = projectTelemetry(selectCycle(events, "old").events, events);
  const latest = projectTelemetry(selectCycle(events).events, events);
  assert.equal(old.capabilities.stats.outcomes.cancelled, 1);
  assert.equal(old.capabilities.stats.durationMs.median, 42);
  assert.equal(old.shiori.nativeLoops.length, 1);
  assert.deepEqual(old.shiori.nativeLoops[0].summary, { stepCount: 7 });
  assert.equal(latest.capabilities.stats.outcomes.pending, 1);
  assert.equal(latest.capabilities.stats.durationMs.median, null);
  assert.equal(latest.shiori.nativeLoops.length, 0);
});

test("compaction candidates keep late HTTP children and finish at armed without becoming model or Shiori totals", () => {
  const e = fixture();
  const candidateTrace = {
    parentSpanId: "loop",
    operationId: "candidate-one",
    modelCallId: "trigger",
  };
  const httpTrace = { parentSpanId: "candidate", operationId: "candidate-one" };
  const events = [
    e("control", "", { mode: "auto" }),
    e("shiori_span_start", "loop", { operation: "invoke_agent" }),
    e(
      "compaction_speculation",
      "candidate",
      { stage: "started" },
      candidateTrace,
    ),
    e("compaction_http_start", "http", {}, httpTrace),
    e("control", "", { mode: "manual" }),
    e("control", "", { mode: "auto" }, { epoch: "new" }),
    e(
      "compaction_http_end",
      "http",
      { status: 200, durationMs: 30_000 },
      httpTrace,
    ),
    e(
      "compaction_speculation",
      "candidate",
      { stage: "armed", durationMs: 80_000 },
      candidateTrace,
    ),
    e(
      "compaction_speculation",
      "candidate",
      { stage: "applied", durationMs: 99_999 },
      candidateTrace,
    ),
    e(
      "compaction_speculation",
      "candidate",
      { stage: "invalidated", durationMs: 99_999 },
      candidateTrace,
    ),
    // Old snapshots or a matching leaf name provide no explicit span identity.
    {
      ...e("compaction_speculation", "", {
        stage: "started",
        snapshotLeafId: "leaf",
      }),
      trace: { epoch: "old" },
    },
    {
      ...e("compaction_speculation", "", {
        stage: "armed",
        snapshotLeafId: "leaf",
        durationMs: 100,
      }),
      trace: { epoch: "old" },
    },
    {
      ...e("compaction_http_start", ""),
      trace: { epoch: "old", httpId: "legacy-http" },
    },
    {
      ...e("compaction_http_end", "", { status: 200 }),
      trace: { epoch: "old", httpId: "legacy-http" },
    },
  ];
  const armed = events.find((event) => event.data.stage === "armed")!;
  const selected = selectCycle(events, "old").events;
  const projected = projectTelemetry(selected, events);
  const candidate = projected.spans.find((span) => span.kind === "compaction")!;
  const http = projected.spans.find((span) => span.kind === "compaction-http")!;
  assert.equal(projected.spans.length, 3);
  assert.equal(candidate.name, "准备压缩候选");
  assert.equal(candidate.parentSpanId, "loop");
  assert.equal(candidate.modelCallId, "trigger");
  assert.equal(candidate.operationId, "candidate-one");
  assert.equal(candidate.outcome, "success");
  assert.equal(candidate.endSeq, armed.seq);
  assert.equal(candidate.durationMs, 80_000);
  assert.equal(http.name, "压缩 HTTP · 响应头");
  assert.equal(http.parentSpanId, candidate.spanId);
  assert.equal(http.operationId, candidate.operationId);
  assert.equal(http.outcome, "success");
  assert.equal(http.durationMs, 30_000);
  assert.equal(projected.shiori.stats.started, 1);
  assert.equal(projected.shiori.stats.durationMs.median, null);
  assert.equal(aggregate(selected).summary.completed, 0);
  assert.equal(
    projectTelemetry(selectCycle(events, "new").events, events).spans.length,
    0,
  );
});

test("foreground compaction HTTP belongs to its maintenance span without requiring a new summary result", () => {
  const e = fixture();
  const trace = { operationId: "maintenance-operation", parentSpanId: "loop" };
  const events = [
    e("auto_compaction_start", "maintenance", { reason: "threshold" }, trace),
    e(
      "compaction_http_start",
      "http",
      {},
      { ...trace, parentSpanId: "maintenance" },
    ),
    e(
      "compaction_http_end",
      "http",
      { status: 200, durationMs: 500 },
      { ...trace, parentSpanId: "maintenance" },
    ),
    e(
      "auto_compaction_end",
      "maintenance",
      { aborted: false, durationMs: 900 },
      trace,
    ),
  ];
  const projected = projectTelemetry(events);
  const maintenance = projected.spans.find(
    (span) => span.operation === "maintenance",
  )!;
  const http = projected.spans.find((span) => span.kind === "compaction-http")!;
  assert.equal(projected.spans.length, 2);
  assert.equal(maintenance.name, "压缩维护");
  assert.equal(maintenance.outcome, "success");
  assert.equal(maintenance.durationMs, 900);
  assert.equal(http.parentSpanId, maintenance.spanId);
  assert.equal(http.operationId, maintenance.operationId);
  assert.equal(projected.shiori.stats.started, 0);
  assert.equal(aggregate(events).summary.completed, 0);
  for (const [data, outcome] of [
    [{ aborted: true, error: "cancelled" }, "cancelled"],
    [{ aborted: false, errorMessage: "failed" }, "error"],
  ] as const) {
    const terminal = { ...events.at(-1)!, data };
    assert.equal(
      projectTelemetry([...events.slice(0, -1), terminal]).spans.find(
        (span) => span.operation === "maintenance",
      )?.outcome,
      outcome,
    );
  }
});

test("native chat and tool spans gain business IDs only from facts with the same explicit identity", () => {
  const e = fixture();
  const selected = [
    e("shiori_span_start", "loop", { operation: "invoke_agent" }),
    e(
      "shiori_span_start",
      "chat",
      { operation: "chat" },
      { parentSpanId: "loop" },
    ),
    e("model_start", "chat", {}, { modelCallId: "request-one" }),
    e("shiori_span_end", "chat", { outcome: "success", durationMs: 20 }),
    e(
      "shiori_span_start",
      "tool",
      { operation: "execute_tool" },
      { parentSpanId: "loop" },
    ),
    e(
      "tool_start",
      "tool",
      {},
      { modelCallId: "request-one", toolCallId: "exec-one" },
    ),
    e(
      "shiori_span_start",
      "unrelated",
      { operation: "chat" },
      { parentSpanId: "loop" },
    ),
  ];
  const foreign = e(
    "model_start",
    "chat",
    {},
    { epoch: "new", modelCallId: "request-two" },
  );
  const { spans } = projectTelemetry(selected, [...selected, foreign]);
  assert.equal(
    spans.find((span) => span.spanId === "chat")?.modelCallId,
    "request-one",
  );
  assert.equal(
    spans.find((span) => span.spanId === "chat")?.parentSpanId,
    "loop",
  );
  assert.equal(
    spans.find((span) => span.spanId === "tool")?.modelCallId,
    "request-one",
  );
  assert.equal(
    spans.find((span) => span.spanId === "tool")?.toolCallId,
    "exec-one",
  );
  assert.equal(
    spans.find((span) => span.spanId === "loop")?.modelCallId,
    undefined,
  );
  assert.equal(
    spans.find((span) => span.spanId === "unrelated")?.modelCallId,
    undefined,
  );
});

test("device durations use matching original clocks and preserve errors or cancellation", () => {
  const e = fixture();
  const origin = (event: Event, clockId: string, atMs: number): Event => ({
    ...event,
    source: { component: "baseware" },
    origin: {
      clockId,
      atMs,
      at: new Date(atMs).toISOString(),
      seq: event.seq,
      eventId: `${clockId}:${event.seq}`,
    },
  });
  const events = [
    origin(
      e("command", "device", { id: "gamepad" }, { parentSpanId: "capability" }),
      "device-clock",
      100,
    ),
    origin(
      e("execution_error", "device", {
        outcome: "error",
        error: "driver failed",
      }),
      "device-clock",
      125,
    ),
    origin(
      e("observation_start", "camera", { sensorId: "screen" }),
      "clock-a",
      1000,
    ),
    origin(
      e("observation_error", "camera", { outcome: "cancelled" }),
      "clock-b",
      1099,
    ),
    e("command", "legacy", { id: "gamepad" }),
    e("execution", "legacy", { outcome: "success" }),
  ];
  const result = projectTelemetry(events);
  assert.equal(
    result.spans.find((span) => span.spanId === "device")?.durationMs,
    25,
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "device")?.parentSpanId,
    "capability",
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "camera")?.durationMs,
    null,
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "legacy")?.durationMs,
    null,
  );
  assert.deepEqual(result.devices.outcomes, {
    success: 1,
    error: 1,
    cancelled: 1,
    pending: 0,
    unknown: 0,
  });
});

test("sampling details share their controller span without duplicating device operations", () => {
  const e = fixture();
  const result = projectTelemetry([
    e("command", "capture", { controllerId: "screen", requiresControl: false }),
    e("observation_start", "capture", { controllerId: "screen", argv: ["capture"] }),
    e("execution", "capture", { controllerId: "screen", requiresControl: false, outcome: "success", durationMs: 12 }),
    e("observation", "capture", { id: "frame", controllerId: "screen" }),
    e("observation_end", "capture", { outcome: "success" }),
    e("observation_start", "legacy", { sensorId: "old-screen" }),
    e("observation_end", "legacy", { outcome: "success" }),
    e("command", "failed", { controllerId: "screen", requiresControl: false }),
    e("observation_start", "failed", { controllerId: "screen" }),
    e("execution_error", "failed", { outcome: "error" }),
    e("observation_error", "failed", { outcome: "error" }),
  ]);
  const devices = result.spans.filter((span) => span.kind === "device");
  assert.equal(devices.length, 3);
  assert.deepEqual(devices.map((span) => [span.name, span.operation]), [["screen", "execute"], ["old-screen", "observe"], ["screen", "execute"]]);
  assert.equal(devices[0].durationMs, 12);
  assert.equal(result.devices.outcomes.error, 1);
});

test("native totals stay separate from model metrics; old logs remain unlabelled with no invented spans", () => {
  const e = fixture();
  const legacy = {
    ...e("model_start", "", {}, { modelCallId: "model" }),
    source: undefined,
  };
  const events = [
    e("shiori_span_start", "loop", { operation: "invoke_agent" }),
    legacy,
    e(
      "model_end",
      "",
      {
        durationMs: 100,
        stopReason: "stop",
        usage: { input: 10, cacheRead: 90 },
      },
      { modelCallId: "model" },
    ),
    e("shiori_run_end", "loop", {
      summary: { usage: { inputTokens: 100, cachedInputTokens: 90 } },
    }),
    e("capability_start", "missing-outcome", { id: "test" }),
    e("capability_end", "missing-outcome"),
    { ...e("capability_start", "", { id: "legacy" }), trace: {} },
  ];
  const data = aggregate(events),
    telemetry = projectTelemetry(events);
  assert.equal(data.summary.completed, 1);
  assert.equal(data.calls[0].inputTokens, 100);
  assert.equal(data.summary.cacheHit, 0.9);
  assert.equal(data.summary.p95Ms, 100);
  assert.equal(telemetry.capabilities.stats.started, 1);
  assert.equal(telemetry.capabilities.stats.outcomes.unknown, 1);
  assert.equal(
    telemetry.sources.find((source) => source.component === "unlabelled")
      ?.count,
    1,
  );
  assert.equal(projectTelemetry([]).shiori.stats.durationMs.p95, null);
  assert.equal(aggregate([]).summary.p95Ms, null);
  assert.equal(p95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
});
