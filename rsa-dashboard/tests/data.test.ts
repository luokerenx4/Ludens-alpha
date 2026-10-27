import { clearCatalogCache } from "../lib/data";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, realpath, mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseEvents, aggregate, selectCycle } from "../lib/aggregate";
import {
  resolveRun,
  canControl,
  hostRequest,
  localRequest,
  catalog,
  mediaFile,
  stopRun,
} from "../lib/data";
import type { Event, LiveStatus, RunData } from "../lib/types";

test("run summary retains controller, cache, compaction and skill evidence", () => {
  let seq = 0;
  const event = (type: string, data = {}, trace = {}): Event => ({
    seq: ++seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
    type, data, trace: { epoch: "cycle", modelCallId: "first", ...trace },
  });
  const events = [
    event("control", { mode: "auto" }),
    event("model_start"),
    event("model_http_start", { body: { bytes: 123456 } }),
    event("model_http_end", { fetchToHeadersMs: 4000 }),
    event("model_end", { durationMs: 5000, stopReason: "toolUse", usage: { input: 100, cacheRead: 0 } }),
    event("execution", { status: "completed", exitCode: 0 }),
    event("execution", { controllerId: "screen", requiresControl: false, status: "completed", exitCode: 0 }),
    event("observation", { id: "frame", sensorId: "screen", mediaType: "image/png" }),
    event("tool_start", { toolName: "read", args: { path: "skills/navigation/SKILL.md" } }, { toolCallId: "read" }),
    event("read", { hash: "fixture-hash" }, { toolCallId: "read" }),
    event("tool_end", { isError: false }, { toolCallId: "read" }),
    event("tool_start", { toolName: "edit", args: { path: "skills/navigation/SKILL.md" } }, { toolCallId: "edit" }),
    event("tool_end", { isError: false }, { toolCallId: "edit" }),
    event("tool_start", { toolName: "observe" }, { toolCallId: "observe" }),
    event("tool_end", { isError: false }, { toolCallId: "observe" }),
    event("auto_compaction_start", { reason: "threshold" }),
    event("auto_compaction_end", { result: { preserveData: { openaiRemoteCompaction: {
      usage: { inputTokens: 2000, outputTokens: 100, cachedInputTokens: 0, totalTokens: 2100 },
      retainedImageCount: 0,
    } } } }),
    event("model_start", {}, { modelCallId: "second" }),
    event("model_end", { durationMs: 2000, stopReason: "stop", usage: { input: 10, cacheRead: 90 } }, { modelCallId: "second" }),
    event("model_start", {}, { modelCallId: "last" }),
    event("model_error", { error: "fixture transport failure" }, { modelCallId: "last" }),
    event("model_end", { durationMs: 1000, stopReason: "aborted" }, { modelCallId: "last" }),
    event("control", { mode: "manual" }),
  ];
  const result = aggregate(parseEvents(events.map((entry) => JSON.stringify(entry)).join("\n") + "\n"));
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.actions, 1);
  assert.equal(result.summary.explicitObserves, 1);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.compactions, 1);
  assert.equal(result.summary.cacheHit, 0.45);
  assert.equal(result.summary.warmCacheHit, 0.9);
  assert.equal(result.skills.filter((s) => s.action === "read").length, 1);
  assert.equal(result.skills.filter((s) => s.action === "edit").length, 1);
  assert.ok(
    result.skills
      .filter((s) => s.action === "read")
      .every((s) => !!s.hash && s.ok),
  );
  assert.equal(result.calls[0].wireBytes, 123456);
  assert.equal(result.calls[0].cacheHit, 0);
  assert.equal(result.calls[0].headersMs, 4000);
  assert.ok(result.calls[0].observations.length > 0);
  assert.equal(result.calls.at(-1)?.status, "aborted");
  assert.equal(result.lastControl?.mode, "manual");
  assert.equal(result.activeCompaction, null);
  const compactionDetails = result.notices.find(
    (n) => n.type === "auto_compaction_end",
  )!.details;
  assert.deepEqual(compactionDetails, [
    { label: "压缩输入 tokens", value: "2,000" },
    { label: "压缩输出 tokens", value: "100" },
    { label: "压缩缓存 tokens", value: "0" },
    { label: "压缩总 tokens", value: "2,100" },
    { label: "保留图像", value: "0" },
  ]);
});

test("HTTP request sizes use wire bytes rather than archived semantic JSON size", () => {
  const bodies = [
    { encoding: "gzip", bytes: 321 },
    { encoding: "rsa-json-v1", bytes: 5000, wire: { bytes: 456, encoding: "gzip" } },
    { encoding: "rsa-json-v1", bytes: 9000 },
  ];
  const events: Event[] = bodies.flatMap((body, index) => ["model_start", "model_http_start"].map((type, step) => ({
    seq: index * 2 + step + 1, at: new Date(index * 1000).toISOString(), atMs: index * 1000,
    type, data: type === "model_http_start" ? { body } : {}, trace: { epoch: "cycle", modelCallId: `model-${index}` },
  })));
  assert.deepEqual(aggregate(events).calls.map(call => call.wireBytes), [321, 456, null]);
});

test("epoch-only shell actions count in the run without being attributed to a nearby model request", () => {
  let seq = 0;
  const event = (type: string, data = {}, trace = {}): Event => ({
    seq: ++seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
    type, data, trace: { epoch: "cycle", ...trace },
  });
  const success = { requiresControl: true, status: "completed", exitCode: 0 };
  const result = aggregate(selectCycle([
    event("control", { mode: "auto" }),
    event("model_start", {}, { modelCallId: "first" }),
    event("execution", success, { traceId: "shell", spanId: "action" }),
    event("execution", { ...success, requiresControl: false }, { traceId: "shell", spanId: "sampling" }),
    event("execution", success, { epoch: "other", traceId: "other", spanId: "action" }),
    event("model_start", {}, { modelCallId: "second" }),
    event("execution", success, { traceId: "background", spanId: "late-action" }),
    event("execution", success, { modelCallId: "first", traceId: "explicit", spanId: "action" }),
  ], "cycle").events);
  assert.equal(result.summary.actions, 3);
  assert.deepEqual(result.calls.map(call => call.actions), [1, 0]);
});

test("startup compaction is visible without fabricating a main-loop request", () => {
  const start: Event = {
    seq: 1,
    at: "2026-10-16T03:00:00Z",
    atMs: 0,
    type: "auto_compaction_start",
    trace: {},
    data: { reason: "threshold" },
  };
  const now = Date.parse("2026-10-16T03:01:15Z");
  const pending = aggregate([start], now);
  assert.deepEqual(pending.activeCompaction, {
    startedAt: start.at,
    elapsedMs: 75000,
    reason: "threshold",
  });
  assert.equal(pending.calls.length, 0);
  assert.equal(pending.summary.completed, 0);
  const finished = aggregate(
    [
      start,
      {
        ...start,
        seq: 2,
        type: "auto_compaction_end",
        at: "2026-10-16T03:01:00Z",
        atMs: 60000,
      },
    ],
    now,
  );
  assert.equal(finished.activeCompaction, null);
  assert.equal(finished.summary.compactions, 1);
});

test("sampling failure details do not count twice beside the controller failure", () => {
  const events = ["command", "observation_start", "execution_error", "observation_error"].map((type, index): Event => ({
    seq: index + 1, type, at: new Date(index).toISOString(), atMs: index,
    trace: { epoch: "cycle", traceId: "trace", spanId: "capture" },
    data: { controllerId: "screen", requiresControl: false, error: "capture failed", outcome: "error" },
  }));
  const result = aggregate(events);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.notices[0].type, "execution_error");
  const legacy = aggregate([events[3]]);
  assert.equal(legacy.summary.errors, 1);
  assert.equal(legacy.notices[0].type, "observation_error");
});

test("HTTP retries do not inflate local request preparation time", () => {
  const event = (type: string, atMs: number, data = {}): Event => ({
    seq: atMs,
    at: new Date(atMs).toISOString(),
    atMs,
    type,
    trace: { modelCallId: "retry" },
    data,
  });
  const result = aggregate([
    event("model_start", 100),
    event("model_http_start", 250),
    event("model_http_error", 10250, { fetchDurationMs: 10000 }),
    event("model_http_start", 11250),
    event("model_http_end", 13250, { fetchToHeadersMs: 2000 }),
  ]);
  assert.equal(result.calls[0].phases.preparationMs, 150);
  assert.equal(result.calls[0].attempts, 2);
  assert.equal(result.calls[0].headersMs, 12000);
});

test("independent compaction HTTP attempts and usage stay outside main-loop metrics", () => {
  let seq = 0;
  const event = (
    type: string,
    httpId: string,
    data: Record<string, unknown>,
  ): Event => ({
    seq: ++seq,
    at: "2026-10-16T03:00:00Z",
    atMs: seq * 1000,
    type,
    trace: { httpId },
    data,
  });
  const events = [
    event("auto_compaction_start", "", { reason: "threshold" }),
    event("compaction_http_start", "a", {
      endpoint: "https://chatgpt.com/backend-api/codex/responses/compact",
      bodyBytes: 1000000,
    }),
    event("compaction_http_error", "a", {
      error: "TLS failure",
      code: "TLS_ERROR",
      aborted: false,
      fetchDurationMs: 10000,
    }),
    event("compaction_http_start", "b", {
      endpoint: "https://chatgpt.com/backend-api/codex/responses/compact",
      bodyBytes: 1000000,
    }),
    event("compaction_http_end", "b", { status: 503, fetchToHeadersMs: 20000 }),
    event("compaction_http_start", "c", {
      endpoint: "https://chatgpt.com/backend-api/codex/responses/compact",
    }),
    event("compaction_http_end", "c", { status: 200, fetchToHeadersMs: 30000 }),
  ];
  const pending = aggregate(events);
  assert.equal(pending.calls.length, 0);
  assert.equal(pending.summary.completed, 0);
  assert.equal(pending.summary.cacheHit, null);
  assert.equal(pending.summary.medianMs, null);
  assert.equal(pending.summary.errors, 2);
  assert.notEqual(pending.activeCompaction, null); // Headers do not mean compaction finished.
  assert.equal(
    pending.notices.filter((n) => n.text.includes("重试")).length,
    0,
  );
  assert.deepEqual(
    pending.notices.find((n) => n.type === "compaction_http_end")!.details,
    [
      { label: "HTTP 状态", value: "503" },
      { label: "响应头前等待", value: "20.0s" },
    ],
  );
  assert.equal(
    pending.notices.find((n) => n.type === "compaction_http_end")!.failed,
    true,
  );
  const finished = aggregate([
    ...events,
    event("auto_compaction_end", "", {
      result: {
        preserveData: {
          openaiRemoteCompaction: {
            usage: {
              inputTokens: 5000,
              cachedInputTokens: 3000,
              outputTokens: 200,
              totalTokens: 5200,
            },
            retainedImageCount: 0,
          },
        },
      },
    }),
  ]);
  assert.equal(finished.activeCompaction, null);
  assert.equal(finished.summary.cacheHit, null);
  assert.equal(finished.summary.completed, 0);
  assert.equal(
    finished.notices
      .at(-1)!
      .details!.find((d) => d.label === "压缩缓存 tokens")!.value,
    "3,000",
  );
});

test("empty/in-flight log has no fabricated completed requests", () => {
  assert.equal(aggregate([]).summary.medianMs, null);
  assert.equal(parseEvents('{"seq":1}\n{"seq":').length, 1);
  const pending = aggregate([
    {
      type: "model_start",
      trace: { modelCallId: "abc" },
      data: {},
      at: new Date().toISOString(),
      atMs: 1,
      seq: 1,
    } as Event,
  ]);
  assert.equal(pending.summary.completed, 0);
  assert.equal(pending.calls[0].status, "pending");
  assert.equal(pending.summary.warmCacheHit, null);
  assert.throws(() => parseEvents("not-json\n"));
});

test("run resolution rejects traversal and symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-dashboard-test-"));
  try {
    await mkdir(join(root, "game/runs/valid"), { recursive: true });
    assert.equal(
      await resolveRun("game", "valid", root),
      await import("node:fs/promises").then((f) =>
        f.realpath(join(root, "game/runs/valid")),
      ),
    );
    await assert.rejects(resolveRun("../game", "valid", root));
    await assert.rejects(resolveRun("game", "..", root));
    await symlink(tmpdir(), join(root, "game/runs/escape"));
    await assert.rejects(resolveRun("game", "escape", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace index discovers external workspace logs alongside retained historical runs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rsa-dashboard-workspace-"));
  const base = await realpath(temp);
  const root = join(base, "artifacts");
  const workspace = join(base, "workspace-a");
  const state = join(root, "ws-workspace-a");
  try {
    await mkdir(join(state, "runs/old"), { recursive: true });
    await mkdir(join(workspace, "logs/new"), { recursive: true });
    await writeFile(join(state, "workspace.json"), JSON.stringify({ workspace }));
    const manifest = JSON.stringify({ model: "test", seconds: 600, drivers: [{ id: "test", version: "1" }] });
    await writeFile(join(state, "runs/old/manifest.json"), manifest);
    await writeFile(join(workspace, "logs/new/manifest.json"), manifest);
    assert.equal(await resolveRun("ws-workspace-a", "new", root), join(workspace, "logs/new"));
    assert.equal(await resolveRun("ws-workspace-a", "old", root), join(state, "runs/old"));
    const projects = await catalog(root);
    assert.deepEqual(projects[0].runs.map((run) => run.id).sort(), ["new", "old"]);
    assert.equal(projects[0].workspace, workspace);
    await symlink(join(state, "runs/old"), join(workspace, "logs/escape"));
    await assert.rejects(resolveRun("ws-workspace-a", "escape", root));
    await rm(join(workspace, "logs"), { recursive: true });
    clearCatalogCache();
    assert.deepEqual((await catalog(root))[0].runs.map((run) => run.id), ["old"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("control is confined to newest matching connected host", () => {
  const live = { runId: "new", connected: true, epoch: "active" } as LiveStatus;
  assert.equal(canControl("new", "new", live, "active"), true);
  assert.equal(canControl("new", "old", live, "active"), false);
  assert.equal(
    canControl("new", "new", { ...live, runId: "other" }, "active"),
    false,
  );
  assert.equal(
    canControl("new", "new", { ...live, connected: false }, "active"),
    false,
  );
});

test("HTTP controls reject cross-origin and nonlocal callers", () => {
  assert.throws(() =>
    localRequest(
      new Request("http://evil.test/api", { headers: { host: "evil.test" } }),
    ),
  );
  assert.throws(() =>
    localRequest(
      new Request("http://127.0.0.1:3015/api", {
        headers: { host: "127.0.0.1:3015", origin: "https://evil.test" },
      }),
      true,
    ),
  );
  assert.doesNotThrow(() =>
    localRequest(
      new Request("http://127.0.0.1:3015/api", {
        headers: { host: "127.0.0.1:3015", origin: "http://127.0.0.1:3015" },
      }),
      true,
    ),
  );
});

test("IPC communicates exact guarded control fields over local socket", async () => {
  const socket = join(tmpdir(), `rsa-dashboard-${process.pid}.sock`);
  let received: unknown;
  const server = createServer((client) =>
    client.once("data", (data) => {
      received = JSON.parse(data.toString());
      client.end(
        JSON.stringify({
          ok: true,
          value: { runId: "current", mode: "manual" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const request = {
      kind: "auto",
      argv: ["off"],
      runId: "current",
      expectedEpoch: "epoch",
    };
    const status = await hostRequest(socket, request);
    assert.deepEqual(received, request);
    assert.equal(status.mode, "manual");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("catalog is empty before the first run but does not hide invalid roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-dashboard-catalog-"));
  try {
    assert.deepEqual(await catalog(join(root, "not-created")), []);
    assert.deepEqual(await catalog(root), []);
    const file = join(root, "not-a-directory");
    await writeFile(file, "");
    await assert.rejects(catalog(file), { code: "ENOTDIR" });
    await assert.rejects(mediaFile("../game", "run", "frame"), /无效的项目 ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Next normalizes request.url to its listener hostname; browsers retain the original Host.
test("same-origin validation uses the browser Host even when Next normalizes URL", () => {
  assert.doesNotThrow(() =>
    localRequest(
      new Request("http://localhost:3015/api/control", {
        headers: { host: "127.0.0.1:3015", origin: "http://127.0.0.1:3015" },
      }),
      true,
    ),
  );
});

test("two epochs in one host have isolated time, requests, actions and late cleanup", () => {
  let seq = 0;
  const event = (
    epoch: string,
    type: string,
    atMs: number,
    data: Record<string, any> = {},
    extra = {},
  ): Event => ({
    seq: ++seq,
    at: new Date(Date.parse("2026-10-16T03:00:00Z") + atMs).toISOString(),
    atMs,
    type,
    trace: { epoch, ...extra },
    data,
  });
  const events = [
    event("old", "control", 0, { mode: "auto" }),
    event("old", "model_start", 1000, {}, { modelCallId: "a" }),
    event(
      "old",
      "model_end",
      2000,
      {
        durationMs: 1000,
        stopReason: "toolUse",
        usage: { input: 10, cacheRead: 90 },
      },
      { modelCallId: "a" },
    ),
    event(
      "old",
      "execution",
      3000,
      { status: "completed", exitCode: 0 },
      { modelCallId: "a" },
    ),
    event(
      "old",
      "observation",
      4000,
      { id: "old-image", sensorId: "screen", mediaType: "image/png" },
      { modelCallId: "a" },
    ),
    event("old", "control", 300000, { mode: "manual" }),
    event("new", "control", 301000, { mode: "auto" }),
    event("new", "model_start", 302000, {}, { modelCallId: "b" }),
    event(
      "old",
      "tool_start",
      303000,
      { toolName: "read", args: { path: "skills/old/SKILL.md" } },
      { modelCallId: "a", toolCallId: "late-read" },
    ),
    event(
      "old",
      "observation",
      304000,
      { id: "old-late-image", sensorId: "screen", mediaType: "image/png" },
      { modelCallId: "a" },
    ),
    event("new", "auto_compaction_start", 305000, { reason: "threshold" }),
    event("new", "auto_compaction_end", 306000),
    event(
      "new",
      "model_end",
      307000,
      {
        durationMs: 5000,
        stopReason: "stop",
        usage: { input: 100, cacheRead: 0 },
      },
      { modelCallId: "b" },
    ),
    event("new", "control", 601000, { mode: "manual" }),
  ];
  const selection = selectCycle(events);
  assert.equal(selection.selectedEpoch, "new");
  assert.equal(selection.cycles.length, 2);
  const latest = aggregate(selection.events);
  const older = aggregate(selectCycle(events, "old").events);
  assert.equal(latest.summary.elapsedSeconds, 300);
  assert.equal(older.summary.elapsedSeconds, 300);
  assert.equal(latest.calls.length, 1);
  assert.equal(latest.calls[0].id, "b");
  assert.equal(older.calls.length, 1);
  assert.equal(older.calls[0].id, "a");
  assert.equal(latest.summary.cacheHit, 0);
  assert.equal(older.summary.cacheHit, 0.9);
  assert.equal(latest.summary.actions, 0);
  assert.equal(older.summary.actions, 1);
  assert.equal(latest.observations.length, 0);
  assert.equal(older.observations.length, 2);
  assert.equal(latest.skills.length, 0);
  assert.equal(older.skills[0].path, "skills/old/SKILL.md");
  assert.equal(latest.summary.compactions, 1);
  assert.equal(older.summary.compactions, 0);
  assert.deepEqual(selectCycle([]), {
    cycles: [],
    selectedEpoch: null,
    events: [],
  });
  assert.equal(selectCycle([{ ...events[0], trace: {} }]).events.length, 0);
  assert.throws(() => selectCycle(events, "absent"));
});

test("old epoch disables the button and POST stop guard rejects before any control IPC", async () => {
  const live = {
    runId: "same-run",
    connected: true,
    epoch: "new",
    mode: "auto",
  } as LiveStatus;
  assert.equal(canControl("same-run", "same-run", live, "new"), true);
  assert.equal(canControl("same-run", "same-run", live, "old"), false);
  assert.equal(canControl("same-run", "same-run", live, null), false);
  let selected: string | undefined;
  const read = async (_project: string, _run: string, epoch?: string) => {
    selected = epoch;
    return { live, selectedEpoch: "old", controlAllowed: false } as RunData;
  };
  await assert.rejects(
    stopRun("project", "same-run", "old", read),
    /控制状态已变化/,
  );
  assert.equal(selected, "old");
  // Even a mistakenly enabled button cannot pass the explicit live-epoch guard.
  await assert.rejects(
    stopRun(
      "project",
      "same-run",
      "old",
      async () =>
        ({ live, selectedEpoch: "old", controlAllowed: true }) as RunData,
    ),
    /控制状态已变化/,
  );
  await assert.rejects(
    stopRun("project", "same-run", null, read),
    /必须明确选择/,
  );
});

test("exec timing joins epoch/model/tool identity and pending durations stay unknown", () => {
  let seq = 0;
  const event = (
    modelCallId: string,
    type: string,
    atMs: number,
    epoch = "cycle",
    data: Record<string, any> = {},
  ): Event => ({
    seq: ++seq,
    at: new Date(atMs).toISOString(),
    atMs,
    type,
    trace: { epoch, modelCallId, toolCallId: "reused-tool-id" },
    data,
  });
  const events = [
    event("a", "model_start", 0),
    event("a", "tool_start", 10, "cycle", {
      toolName: "exec",
      args: { command: "opaque shell command" },
    }),
    event("a", "exec", 20),
    event("b", "model_start", 30),
    event("b", "tool_start", 40, "cycle", { toolName: "exec", args: {} }),
    event("b", "exec", 50),
    event("a", "exec_result", 120),
    event("a", "tool_end", 210, "cycle", { isError: false }),
    // An event with matching model/tool but another epoch must not complete b.
    event("b", "exec_result", 250, "other-cycle"),
    event("b", "tool_end", 300, "other-cycle", { isError: true }),
  ];
  const pending = aggregate(events);
  assert.equal(pending.calls[0].tools[0].commandMs, 100);
  assert.equal(pending.calls[0].tools[0].durationMs, 200);
  assert.equal(pending.calls[0].tools[0].ok, true);
  assert.equal(pending.calls[1].tools[0].commandMs, null);
  assert.equal(pending.calls[1].tools[0].durationMs, null);
  assert.equal(pending.calls[1].tools[0].ok, null);
  const finished = aggregate([
    ...events,
    event("b", "exec_result", 350),
    event("b", "tool_end", 540, "cycle", { isError: false }),
  ]);
  assert.equal(finished.calls[0].tools[0].commandMs, 100);
  assert.equal(finished.calls[0].tools[0].durationMs, 200);
  assert.equal(finished.calls[1].tools[0].commandMs, 300);
  assert.equal(finished.calls[1].tools[0].durationMs, 500);
});

test("overlapping observations retain raw requests by operation ID rather than completion order", () => {
  let seq = 0;
  const event = (type: string, operationId: string, data: Record<string, unknown>, epoch = "cycle"): Event => ({
    seq: ++seq, type, at: new Date(seq).toISOString(), atMs: seq,
    trace: { epoch, operationId }, data,
  });
  const first = { controllerId: "screen.capture", arguments: { delayMs: 1500 } };
  const second = { controllerId: "audio", argv: ["sample", "2000"] };
  const result = aggregate([
    event("observation_start", "first", first),
    event("observation_start", "second", { sensorId: second.controllerId, argv: second.argv }),
    event("observation_start", "first", { sensorId: "old", argv: [] }, "old-cycle"),
    event("observation", "second", { id: "b", sensorId: "audio", mediaType: "audio/wav" }),
    event("observation", "first", { id: "a", controllerId: "screen", mediaType: "image/png", timing: { requestedAtMs: 100, receivedAtMs: 1800 } }),
    event("observation", "unmatched", { id: "c", sensorId: "screen", mediaType: "image/png" }),
  ]);
  assert.deepEqual(result.observations[0].request, second);
  assert.deepEqual(result.observations[1].request, first);
  assert.equal(result.observations[0].controller, "audio");
  assert.equal(result.observations[1].controller, "screen");
  assert.equal(result.observations[1].captureMs, 1700); // Preserve elapsed time, do not interpret argv.
  assert.equal(result.observations[2].request, undefined);
});

test("WS frame metadata stays separate from HTTP body, attempts and header timing", () => {
  let seq = 0;
  const event = (modelCallId: string, type: string, data = {}): Event => ({
    seq: ++seq, type, at: new Date(seq * 100).toISOString(), atMs: seq * 100,
    trace: { epoch: "cycle", modelCallId, requestId: modelCallId }, data,
  });
  const events = [
    event("full", "model_start"),
    event("full", "model_request", { transport: "websocket", bodyBytes: 9000000, incremental: false }),
  ];
  const prepared = aggregate(events).calls[0];
  assert.equal(prepared.transport, "websocket");
  assert.equal(prepared.frameBytes, 9000000);
  assert.equal(prepared.wsFrames, 0); // A built payload alone is not a dispatch.
  const result = aggregate([
    ...events,
    event("full", "model_ws_dispatch", { bodyBytes: 9000010 }),
    event("full", "model_stream_start", { modelElapsedMs: 1000, afterDispatchMs: 700 }),
    event("full", "model_end", { durationMs: 5000, firstStreamEventMs: 1000, afterFirstStreamMs: 4000 }),
    event("delta", "model_start"),
    event("delta", "model_request", { transport: "websocket", bodyBytes: 200000, incremental: true }),
    event("delta", "model_ws_dispatch", { bodyBytes: 200010 }),
    event("delta", "model_end", { durationMs: 3000 }),
    event("fallback", "model_start"),
    event("fallback", "model_request", { transport: "websocket", bodyBytes: 30000000, incremental: false }),
    event("fallback", "model_request", { bodyBytes: 30000000 }),
    event("fallback", "model_http_start", { body: { bytes: 4000000 } }),
    event("fallback", "model_http_end", { fetchToHeadersMs: 1500 }),
    event("fallback", "model_end", { durationMs: 4000 }),
  ]);
  const [full, delta, fallback] = result.calls;
  assert.equal(full.frameBytes, 9000010);
  assert.equal(full.incremental, false);
  assert.equal(full.wsFrames, 1);
  assert.equal(full.phases.afterDispatchMs, 700);
  assert.equal(full.phases.afterFirstStreamMs, 4000);
  assert.equal(delta.frameBytes, 200010);
  assert.equal(delta.incremental, true);
  for (const call of [full, delta]) {
    assert.equal(call.wireBytes, null);
    assert.equal(call.headersMs, null);
    assert.equal(call.attempts, 0);
  }
  assert.equal(fallback.transport, "sse");
  assert.equal(fallback.wsFrames, 0);
  assert.equal(fallback.frameBytes, null);
  assert.equal(fallback.wireBytes, 4000000);
  assert.equal(fallback.headersMs, 1500);
  assert.equal(fallback.attempts, 1);
  assert.equal(result.summary.medianHeadersMs, 1500);
});
