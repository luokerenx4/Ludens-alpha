import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/analyze-run.py", import.meta.url).pathname;
const emptyStats = { count: 0, min: null, median: null, p95: null, max: null, sum: 0 };
const emptySpeculation = { started: 0, armed: 0, invalidated: 0, waiting: 0, applied: 0, failed: 0, cancelled: 0, armedDurationMs: emptyStats };

function fixture() {
  let seq = 0;
  return (type: string, epoch: string, data: Record<string, unknown>, trace: Record<string, unknown> = {}) => {
    seq++;
    return { seq, type, atMs: seq * 1000, at: new Date(seq * 1000).toISOString(), trace: { epoch, ...trace }, data };
  };
}

async function analyze(events: unknown[], epoch?: string) {
  const directory = await mkdtemp(join(tmpdir(), "rsa-analysis-"));
  try {
    await writeFile(join(directory, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const result = Bun.spawnSync(["python3", script, directory, ...(epoch ? ["--epoch", epoch] : [])]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(await readFile(join(directory, "analysis.json"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("analysis without speculation events has zero lifecycle counts and no model requests", async () => {
  const event = fixture();
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("control", "one", { mode: "manual", reason: "time budget" }),
  ]);
  expect(report.compactionSpeculation).toEqual([]);
  expect(report.summary.compactionSpeculation).toEqual(emptySpeculation);
  expect(report.compactionMaintenance).toEqual([]);
  expect(report.summary.compactionMaintenance).toEqual({ completed: 0, aborted: 0, error: 0, pending: 0, durationMs: emptyStats });
  expect(report.compactionRetries).toEqual([]);
  expect(report.summary.compactionRetries).toEqual({ announcedRetries: null, errorReasons: {} });
  expect(report.summary.completedRequests).toBe(0);
  expect(report.summary).toMatchObject({ toolErrors: 0, toolErrorsByName: {} });
  expect(report.summary.controllerExecutionErrors).toBe(0);
  expect(report.controllerExecutionErrors).toEqual([]);
  expect(report.firstRequest).toBeNull();
});

test("analysis pairs concurrent capabilities by span, keeps late cancellation, and separates native loop summaries", async () => {
  const event = fixture();
  const trace = (spanId: string, parentSpanId?: string) => ({ traceId: "trace", spanId, parentSpanId });
  const native = (row: ReturnType<ReturnType<typeof fixture>>) => ({ ...row,
    source: { component: "shiori", implementation: "omp", implementationVersion: "18.9.1" } });
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    native(event("shiori_span_start", "one", { operation: "invoke_agent", name: "agent" }, trace("loop"))),
    event("capability_start", "one", { action: "call", id: "python/macros.py:move" }, trace("a", "tool")),
    event("python_capability", "one", { capabilityId: "macro", codeSHA: "version-a" }, trace("a", "tool")),
    event("capability_start", "one", { action: "call", id: "python/macros.py:move" }, trace("b", "tool")),
    event("python_capability", "one", { capabilityId: "macro", codeSHA: "version-a" }, trace("b", "tool")),
    event("python_capability_result", "one", { outcome: "success", durationMs: 10 }, trace("b", "tool")),
    event("capability_end", "one", { outcome: "success", durationMs: 12 }, trace("b", "tool")),
    event("control", "one", { mode: "manual", reason: "time budget" }),
    event("python_capability_result", "one", { outcome: "cancelled", durationMs: 30 }, trace("a", "tool")),
    event("capability_end", "one", { outcome: "cancelled", durationMs: 32 }, trace("a", "tool")),
    native(event("shiori_run_end", "one", { scope: "agent_loop", summary: { usage: { totalTokens: 100 } }, coverage: {} }, trace("loop"))),
    native(event("shiori_span_end", "one", { outcome: "cancelled", durationMs: 50 }, trace("loop"))),
    event("control", "two", { mode: "auto", epoch: "two" }),
    event("capability_start", "two", { action: "call", id: "python/macros.py:move" }, trace("c")),
  ], "one");
  expect(report.summary.capabilities).toMatchObject({ started: 2, outcomes: { cancelled: 1, success: 1 },
    durationMs: { median: 22, p95: 32 } });
  expect(report.capabilities.map((span: any) => [span.trace.spanId, span.outcome])).toEqual([["a", "cancelled"], ["b", "success"]]);
  expect(report.summary.pythonCapabilities.started).toBe(2);
  expect(report.pythonCapabilities[0].codeSHA).toBe("version-a");
  expect(report.summary.shiori.nativeLoops).toBe(1);
  expect(report.shiori.runs[0].summary.usage.totalTokens).toBe(100);
  expect(report.summary.sources.shiori).toBe(3);
  expect(report.summary.completedRequests).toBe(0);
});

test("analysis retains ready and applied boundaries and reports candidate duration separately from waiting", async () => {
  const event = fixture();
  const events = [
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("compaction_speculation", "one", { stage: "started", method: "remote", snapshotLeafId: "first-leaf", contextTokensAtStart: 224_000, thresholdTokens: 256_000 }),
    event("compaction_speculation", "one", { stage: "waiting", contextTokens: 256_500 }),
    event("compaction_speculation", "one", { stage: "armed", snapshotLeafId: "first-leaf", durationMs: 80_000, tokensBefore: 224_100, prompt: "private-prompt", headers: { authorization: "private-token" }, reason: { nested: "private-object" } }),
    event("compaction_speculation", "one", { stage: "applied", snapshotLeafId: "first-leaf" }),
    event("compaction_speculation", "one", { stage: "started", snapshotLeafId: "second-leaf" }),
    event("compaction_speculation", "one", { stage: "armed", snapshotLeafId: "second-leaf", durationMs: 86_000 }),
    event("compaction_speculation", "one", { stage: "applied", snapshotLeafId: "second-leaf" }),
    event("control", "one", { mode: "manual", reason: "time budget" }),
  ];
  const report = await analyze(events);
  expect(report.compactionSpeculation).toHaveLength(7);
  expect(report.compactionSpeculation[0]).toEqual({ seq: events[1]!.seq, at: events[1]!.at, atMs: events[1]!.atMs,
    trace: { epoch: "one" }, data: events[1]!.data });
  expect(report.compactionSpeculation[2].data).toEqual({ stage: "armed", snapshotLeafId: "first-leaf", durationMs: 80_000, tokensBefore: 224_100 });
  expect(report.compactionSpeculation.filter((item: { data: { stage: string } }) => item.data.stage === "applied").map((item: { data: { snapshotLeafId: string } }) => item.data.snapshotLeafId)).toEqual(["first-leaf", "second-leaf"]);
  expect(report.summary.compactionSpeculation).toEqual({ ...emptySpeculation, started: 2, armed: 2, waiting: 1, applied: 2,
    armedDurationMs: { count: 2, min: 80_000, median: 83_000, p95: 86_000, max: 86_000, sum: 166_000 } });
  expect(JSON.stringify(report)).not.toContain("private-");
  expect(report.summary.compactionHttp.attempts).toBe(0);
  expect(report.summary.compactionHttp.retryCount).toBeNull();
});

test("analysis isolates lifecycle to the chosen epoch and retains its late HTTP cleanup", async () => {
  const event = fixture();
  const events = [
    event("control", "old", { mode: "auto", epoch: "old" }),
    event("compaction_speculation", "old", { stage: "started", snapshotLeafId: "same-leaf" }),
    event("control", "old", { mode: "manual" }),
    event("control", "selected", { mode: "auto", epoch: "selected" }),
    event("compaction_speculation", "selected", { stage: "started", snapshotLeafId: "same-leaf" }),
    event("compaction_http_start", "selected", { method: "POST", bodyBytes: 123 }, { httpId: "reused-http" }),
    event("compaction_speculation", "old", { stage: "armed", snapshotLeafId: "same-leaf", durationMs: 99_999 }),
    event("control", "selected", { mode: "manual", reason: "time budget" }),
    event("compaction_http_error", "selected", { aborted: true, error: "cancelled", fetchDurationMs: 3000 }, { httpId: "reused-http" }),
    event("compaction_speculation", "selected", { stage: "failed", error: "cancelled" }),
    event("control", "next", { mode: "auto", epoch: "next" }),
    event("compaction_speculation", "next", { stage: "started", snapshotLeafId: "same-leaf" }),
    event("compaction_http_start", "next", { bodyBytes: 999 }, { httpId: "reused-http" }),
    event("compaction_http_end", "next", { status: 200, fetchToHeadersMs: 5000 }, { httpId: "reused-http" }),
    event("compaction_speculation", "next", { stage: "armed", durationMs: 90_000 }),
  ];
  const report = await analyze(events, "selected");
  expect(report.window).toMatchObject({ epoch: "selected", stopReason: "time budget", observedElapsedMs: 4000 });
  expect(report.compactionSpeculation.map((item: { seq: number }) => item.seq)).toEqual([5, 10]);
  expect(report.summary.compactionSpeculation).toEqual({ ...emptySpeculation, started: 1, failed: 1 });
  expect(report.summary.compactionHttp).toMatchObject({ attempts: 1, abortedAttempts: 1, responsesReceived: 0, preparedBodyBytes: 123 });
  expect(report.compactionHttpAttempts[0]).toMatchObject({ epoch: "selected", startSeq: 6, endSeq: 9, state: "aborted", error: "cancelled" });
  await expect(analyze(events)).rejects.toThrow("select one with --epoch");
});

test("analysis counts invalidation and failure without inventing a request pairing or duration", async () => {
  const event = fixture();
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("compaction_speculation", "one", { stage: "started", snapshotLeafId: "leaf" }),
    event("compaction_speculation", "one", { stage: "armed", snapshotLeafId: "leaf" }),
    event("compaction_speculation", "one", { stage: "invalidated", snapshotLeafId: "leaf", reason: "branch-or-headroom" }),
    event("compaction_speculation", "one", { stage: "started", snapshotLeafId: "new-leaf" }),
    event("compaction_speculation", "one", { stage: "failed", method: "remote", error: "fixture failure" }),
    event("control", "one", { mode: "manual" }),
  ]);
  expect(report.summary.compactionSpeculation).toEqual({ ...emptySpeculation, started: 2, armed: 1, invalidated: 1, failed: 1 });
  expect(report.compactionSpeculation[2].data.reason).toBe("branch-or-headroom");
  expect(report.compactionSpeculation[4].data).toEqual({ stage: "failed", method: "remote", error: "fixture failure" });
  expect(report.compactionHttpAttempts).toEqual([]);
});

test("analysis measures foreground compaction windows including late cancellation", async () => {
  const event = fixture();
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("auto_compaction_start", "one", { reason: "threshold" }),
    event("compaction_speculation", "one", { stage: "armed", durationMs: 80_000 }),
    event("auto_compaction_end", "one", { aborted: false }),
    event("auto_compaction_start", "one", { reason: "threshold" }),
    event("auto_compaction_end", "one", { aborted: true }),
    event("auto_compaction_start", "one", { reason: "threshold" }),
    event("auto_compaction_end", "one", { errorMessage: "fixture failure" }),
    event("auto_compaction_start", "one", { reason: "threshold" }),
    event("auto_compaction_end", "another-epoch", { aborted: false }),
    event("control", "one", { mode: "manual", reason: "time budget" }),
    event("auto_compaction_end", "one", { aborted: true }),
  ]);
  expect(report.compactions[0]).toMatchObject({ seq: 2, atMs: 2000, epoch: "one" });
  expect(report.compactionMaintenance).toEqual([
    { epoch: "one", trace: { epoch: "one" }, startSeq: 2, endSeq: 4, startAtMs: 2000, endAtMs: 4000, state: "completed", durationMs: 2000 },
    { epoch: "one", trace: { epoch: "one" }, startSeq: 5, endSeq: 6, startAtMs: 5000, endAtMs: 6000, state: "aborted", durationMs: 1000 },
    { epoch: "one", trace: { epoch: "one" }, startSeq: 7, endSeq: 8, startAtMs: 7000, endAtMs: 8000, state: "error", durationMs: 1000 },
    { epoch: "one", trace: { epoch: "one" }, startSeq: 9, endSeq: 12, startAtMs: 9000, endAtMs: 12_000, state: "aborted", durationMs: 3000 },
  ]);
  expect(report.summary.compactionMaintenance).toEqual({ completed: 1, aborted: 2, error: 1, pending: 0,
    durationMs: { count: 4, min: 1000, median: 1500, p95: 3000, max: 3000, sum: 7000 } });
  expect(report.summary.compactionStarts).toBe(4);
  expect(report.summary.compactionEnds).toBe(4);
  expect(report.summary.compactionSpeculation.armedDurationMs.sum).toBe(80_000);
});

test("analysis pairs interleaved maintenance identities and preserves explicit durations and cancelled candidates", async () => {
  const event = fixture();
  const first = { operationId: "maintenance-a", traceId: "trace", spanId: "span-a" };
  const second = { traceId: "trace", spanId: "span-b" };
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("auto_compaction_start", "one", { reason: "threshold" }, first),
    event("auto_compaction_start", "one", { reason: "threshold" }, second),
    event("auto_compaction_end", "one", { aborted: false, durationMs: 500 }, first),
    event("control", "one", { mode: "manual", reason: "time budget" }),
    event("auto_compaction_end", "one", { errorMessage: "candidate unavailable", durationMs: 750 }, second),
    event("compaction_speculation", "one", { stage: "cancelled" }, first),
  ]);
  expect(report.compactionMaintenance).toEqual([
    { epoch: "one", trace: { epoch: "one", ...first }, startSeq: 2, endSeq: 4,
      startAtMs: 2000, endAtMs: 4000, state: "completed", durationMs: 500 },
    { epoch: "one", trace: { epoch: "one", ...second }, startSeq: 3, endSeq: 6,
      startAtMs: 3000, endAtMs: 6000, state: "error", durationMs: 750 },
  ]);
  expect(report.summary.compactionSpeculation).toEqual({ ...emptySpeculation, cancelled: 1 });
  expect(report.compactions[3].error).toBe("candidate unavailable");
});

test("analysis reports explicit native retry warnings despite HTTP 200 and preserves late epoch events", async () => {
  const event = fixture();
  const error = "V2 compaction stream error (server_error): fixture failure";
  const events = [
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("compaction_http_start", "one", { bodyBytes: 123 }, { httpId: "first" }),
    event("compaction_http_end", "one", { status: 200 }, { httpId: "first" }),
    event("compaction_retry", "one", { attempt: 1, retryDelayMs: 1000, model: "gpt-6.1-sol", error,
      headers: { authorization: "private-token" }, prompt: "private-prompt", snapshotLeafId: "private-leaf" }),
    event("compaction_http_start", "one", { bodyBytes: 123 }, { httpId: "second" }),
    event("compaction_http_end", "one", { status: 200 }, { httpId: "second" }),
    event("compaction_retry", "one", { attempt: 2, retryDelayMs: 2000, model: { name: "private-model" }, error: { message: "private-error" } }),
    event("compaction_retry", "other", { attempt: 1, retryDelayMs: 1000, error: "private-other-epoch" }),
    event("control", "one", { mode: "manual", reason: "time budget" }),
    event("compaction_retry", "one", { attempt: 1, retryDelayMs: 1000, error: "late retry" }),
  ];
  const report = await analyze(events, "one");
  expect(report.compactionRetries).toEqual([
    { seq: 4, at: events[3]!.at, atMs: 4000, trace: { epoch: "one" }, data: { attempt: 1, retryDelayMs: 1000, model: "gpt-6.1-sol", error } },
    { seq: 7, at: events[6]!.at, atMs: 7000, trace: { epoch: "one" }, data: { attempt: 2, retryDelayMs: 2000 } },
    { seq: 10, at: events[9]!.at, atMs: 10_000, trace: { epoch: "one" }, data: { attempt: 1, retryDelayMs: 1000, error: "late retry" } },
  ]);
  expect(report.summary.compactionRetries).toEqual({ announcedRetries: 3, errorReasons: { [error]: 1, "late retry": 1 } });
  expect(report.summary.compactionHttp).toMatchObject({ attempts: 2, responsesReceived: 2, failedAttempts: 0, retryCount: null });
  expect(report.summary.retryCount).toBe(0);
  expect(JSON.stringify(report)).not.toContain("private-");
});

test("analysis leaves native retry count unknown when old HTTP attempts have no explicit retry warnings", async () => {
  const event = fixture();
  const report = await analyze([
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("compaction_http_start", "one", {}, { httpId: "first" }),
    event("compaction_http_end", "one", { status: 200 }, { httpId: "first" }),
    event("compaction_http_start", "one", {}, { httpId: "second" }),
    event("compaction_http_end", "one", { status: 200 }, { httpId: "second" }),
    event("control", "one", { mode: "manual" }),
  ]);
  expect(report.compactionRetries).toEqual([]);
  expect(report.summary.compactionRetries).toEqual({ announcedRetries: null, errorReasons: {} });
  expect(report.summary.compactionHttp).toMatchObject({ attempts: 2, responsesReceived: 2, retryCount: null });
});

test("analysis counts tool errors separately from model failures and preserves a successful correction across epochs", async () => {
  const event = fixture();
  const failed = { modelCallId: "first-call", toolCallId: "failed-observe" };
  const corrected = { modelCallId: "next-call", toolCallId: "corrected-observe" };
  const events = [
    event("control", "old", { mode: "auto", epoch: "old" }),
    event("tool_start", "old", { toolName: "observe" }, corrected),
    event("tool_end", "old", { toolName: "observe", isError: true }, corrected),
    event("control", "old", { mode: "manual" }),
    event("control", "selected", { mode: "auto", epoch: "selected" }),
    event("tool_start", "selected", { toolName: "observe", args: { sensorId: "screen", argv: ["--delay-ms", "1800"] } }, failed),
    event("tool_end", "selected", { toolName: "observe", isError: true }, failed),
    event("tool_start", "selected", { toolName: "observe", args: { sensorId: "screen", argv: ["capture", "--delay-ms", "2000"] } }, corrected),
    event("tool_end", "selected", { toolName: "observe", isError: false }, corrected),
    event("tool_start", "selected", { toolName: "exec" }, { modelCallId: "pending-call", toolCallId: "pending-exec" }),
    event("control", "selected", { mode: "manual", reason: "time budget" }),
    event("control", "next", { mode: "auto", epoch: "next" }),
    event("tool_start", "next", { toolName: "observe" }, corrected),
    event("tool_end", "next", { toolName: "observe", isError: true }, corrected),
    event("control", "next", { mode: "manual" }),
  ];
  const report = await analyze(events, "selected");
  expect(report.summary).toMatchObject({
    toolCounts: { observe: 2, exec: 1 }, toolErrors: 1, toolErrorsByName: { observe: 1 },
    failedRequests: 0, httpErrors: 0,
  });
  expect(report.tools.map((tool: { toolName: string; state: string; isError: boolean | null }) => ({
    toolName: tool.toolName, state: tool.state, isError: tool.isError,
  }))).toEqual([
    { toolName: "observe", state: "error", isError: true },
    { toolName: "observe", state: "completed", isError: false },
    { toolName: "exec", state: "pending", isError: null },
  ]);
});

test("analysis links observation arguments by operation and epoch while retaining samples without starts", async () => {
  const event = fixture();
  const sample = (id: string, origin: string | undefined, durationMs: number) => ({
    id, sensorId: "screen", path: `${id}.png`, origin,
    timing: { clock: "fixture", requestedAtMs: 1000, receivedAtMs: 1000 + durationMs },
  });
  const events = [
    event("control", "old", { mode: "auto", epoch: "old" }),
    event("observation_start", "old", { argv: ["old-epoch"] }, { operationId: "missing-start" }),
    event("observation", "old", sample("old", "explicit", 99_999), { operationId: "missing-start" }),
    event("control", "old", { mode: "manual" }),
    event("control", "selected", { mode: "auto", epoch: "selected" }),
    event("observation_start", "selected", { argv: ["capture", "--delay-ms", "18000"] }, { operationId: "explicit" }),
    event("observation_start", "selected", { argv: ["capture"] }, { operationId: "automatic" }),
    event("observation_start", "old", { argv: ["wrong-epoch"] }, { operationId: "explicit" }),
    event("observation", "selected", sample("automatic", "tool_batch", 130), { operationId: "automatic" }),
    event("observation", "selected", sample("explicit", "explicit", 18_131), { operationId: "explicit" }),
    event("observation", "selected", sample("missing", "explicit", 9131), { operationId: "missing-start" }),
    event("observation_start", "selected", { argv: ["unidentified-start"] }),
    event("observation", "selected", sample("unidentified", undefined, 120)),
    event("control", "selected", { mode: "manual" }),
  ];
  const report = await analyze(events, "selected");
  expect(report.observations.map((observation: { id: string; argv: string[] | null }) => ({
    id: observation.id, argv: observation.argv,
  }))).toEqual([
    { id: "automatic", argv: ["capture"] },
    { id: "explicit", argv: ["capture", "--delay-ms", "18000"] },
    { id: "missing", argv: null },
    { id: "unidentified", argv: null },
  ]);
  expect(report.summary.captureMs).toEqual({ count: 4, min: 120, median: 4630.5, p95: 18_131, max: 18_131, sum: 27_512 });
  expect(report.summary.captureMsByOrigin).toEqual({
    tool_batch: { count: 1, min: 130, median: 130, p95: 130, max: 130, sum: 130 },
    explicit: { count: 2, min: 9131, median: 13_631, p95: 18_131, max: 18_131, sum: 27_262 },
    unknown: { count: 1, min: 120, median: 120, p95: 120, max: 120, sum: 120 },
  });
});

test("analysis retains controller errors when the shell batch succeeds and isolates epoch traces", async () => {
  const event = fixture();
  const trace = { modelCallId: "call", requestId: "request", toolCallId: "tool" };
  const failed = { ...trace, operationId: "keyboard" };
  const success = { ...trace, operationId: "pad" };
  const error = "Error: Unknown keyboard key";
  const command = "baseware controller keyboard press --key ESC; baseware controller pad release; sleep .5";
  const events = [
    event("control", "old", { mode: "auto", epoch: "old" }),
    event("command", "old", { id: "old-controller", argv: ["old-args"] }, failed),
    event("execution_error", "old", { error: "old error", aborted: false }, failed),
    event("control", "old", { mode: "manual" }),
    event("control", "selected", { mode: "auto", epoch: "selected" }),
    event("tool_start", "selected", { toolName: "exec" }, trace),
    event("exec", "selected", { command }, trace),
    event("command", "selected", { id: "keyboard", argv: ["press", "--key", "ESC"] }, failed),
    event("command", "old", { id: "wrong-controller", argv: ["wrong-args"] }, failed),
    event("execution_error", "old", { error: "wrong epoch error", aborted: false }, failed),
    event("execution_error", "selected", { error, aborted: false }, failed),
    event("command", "selected", { id: "pad", argv: ["release"] }, success),
    event("execution", "selected", { id: "action", status: "completed", exitCode: 0,
      timing: { requestedAtMs: 12_000, receivedAtMs: 13_000 } }, success),
    event("exec_result", "selected", { exitCode: 0, stderr: `${error}\nUnrelated error text\n` }, trace),
    event("tool_end", "selected", { toolName: "exec", isError: false }, trace),
    event("control", "selected", { mode: "manual", reason: "time budget" }),
    event("execution_error", "selected", { error: "late error", aborted: true }, failed),
    event("control", "next", { mode: "auto", epoch: "next" }),
    event("execution_error", "next", { error: "next error", aborted: false }, failed),
  ];
  const report = await analyze(events, "selected");
  expect(report.summary).toMatchObject({ toolErrors: 0, controllerExecutionErrors: 2,
    controllerActions: 1, controllerExecutionStatuses: { completed: 1 } });
  expect(report.tools[0]).toMatchObject({ state: "completed", isError: false,
    exec: { state: "completed", exitCode: 0 } });
  expect(report.controllerExecutionErrors).toEqual([{
    seq: 11, at: events[10]!.at, atMs: 11_000, epoch: "selected", ...failed,
    commandSeq: 8, controller: "keyboard", argv: ["press", "--key", "ESC"], error, aborted: false,
  }, {
    seq: 17, at: events[16]!.at, atMs: 17_000, epoch: "selected", ...failed,
    commandSeq: 8, controller: "keyboard", argv: ["press", "--key", "ESC"], error: "late error", aborted: true,
  }]);
});

test("analysis attributes late compaction lifecycle to its epoch without extending active time or guessing missing identities", async () => {
  const event = fixture();
  const first = { operationId: "candidate-a", traceId: "trace-a", spanId: "span-a" };
  const second = { operationId: "candidate-b", traceId: "trace-b", spanId: "span-b" };
  const http = { ...first, spanId: "http-span-a", parentSpanId: first.spanId, httpId: "http-a", unknownField: "private-value" };
  const events = [
    event("control", "one", { mode: "auto", epoch: "one" }),
    event("compaction_speculation", "one", { stage: "started", snapshotLeafId: "same-leaf" }, first),
    event("auto_compaction_start", "one", { reason: "threshold" }, first),
    event("compaction_speculation", "one", { stage: "armed", durationMs: 999_999 }, { epoch: null }),
    event("control", "one", { mode: "manual", reason: "time budget" }),
    event("control", "two", { mode: "auto", epoch: "two" }),
    event("compaction_speculation", "two", { stage: "started", snapshotLeafId: "same-leaf" }, second),
    event("compaction_http_start", "one", { bodyBytes: 100 }, http),
    event("compaction_http_end", "one", { status: 200 }, http),
    event("compaction_speculation", "one", { stage: "armed", durationMs: 80_000 }, first),
    event("auto_compaction_end", "one", { aborted: false }, first),
    event("compaction_speculation", "one", { stage: "applied" }, first),
    event("compaction_speculation", "two", { stage: "failed", error: "unattributed" }, { epoch: null }),
    event("compaction_speculation", "two", { stage: "failed", error: "candidate-b failed" }, second),
    event("control", "two", { mode: "manual", reason: "time budget" }),
  ].map(row => ({ ...row, source: { component: row.type === "control" ? "rsa" : "shiori" } }));
  const report = await analyze(events, "one");
  expect(report.window.observedElapsedMs).toBe(4000);
  expect(report.summary.sources).toEqual({ rsa: 2, shiori: 7 });
  expect(report.compactionSpeculation.map((item: { seq: number }) => item.seq)).toEqual([2, 10, 12]);
  expect(report.compactionSpeculation.map((item: { trace: unknown }) => item.trace)).toEqual([
    { epoch: "one", ...first }, { epoch: "one", ...first }, { epoch: "one", ...first },
  ]);
  expect(report.summary.compactionSpeculation).toEqual({ ...emptySpeculation, started: 1, armed: 1, applied: 1,
    armedDurationMs: { count: 1, min: 80_000, median: 80_000, p95: 80_000, max: 80_000, sum: 80_000 } });
  expect(report.compactionHttpAttempts[0]).toMatchObject({ epoch: "one", startSeq: 8, endSeq: 9, bodyBytes: 100,
    trace: { epoch: "one", ...first, spanId: "http-span-a", parentSpanId: first.spanId } });
  expect(JSON.stringify(report)).not.toContain("private-value");
  expect(report.compactionMaintenance[0]).toMatchObject({ epoch: "one", startSeq: 3, endSeq: 11, durationMs: 8000 });
  const next = await analyze(events, "two");
  expect(next.summary.sources).toEqual({ rsa: 2, shiori: 2 });
  expect(next.summary.compactionSpeculation).toEqual({ ...emptySpeculation, started: 1, failed: 1 });
  expect(next.compactionHttpAttempts).toEqual([]);
  expect(next.compactionMaintenance).toEqual([]);
});
