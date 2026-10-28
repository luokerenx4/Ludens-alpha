import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aggregate } from "../lib/aggregate";
import { mediaFile as readMediaFile } from "../lib/data";
import { awaitArchive } from "./fixtures/await-archive";
const mediaFile = (...args: Parameters<typeof readMediaFile>) => awaitArchive(() => readMediaFile(...args));
import { eventObservations, perceptionStatus } from "../lib/observation-events";
import { mediaFailureMessage, observationTime, perceptionAgeMs, samplingDurationMs, selectObservations } from "../components/observation-model";
import { ObservationPanel } from "../components/run-visuals";
import { projectTelemetry } from "../lib/telemetry";
import type { Event, PerceptionSnapshot, RunData } from "../lib/types";

const hook = { id: "python/vision.py:observe", path: "vision.py", codeSHA: "source-hash" };
const makeEvents = () => {
  let seq = 0;
  return (type: string, data: Record<string, unknown>, trace = {}): Event => ({
    seq: ++seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
    type, data, trace: { epoch: "current", ...trace },
  });
};
const completedHook = (id: string, stdout: string, observations: unknown[]) => ({
  hook, outcome: "success",
  result: { id, stdout, observations, status: "completed", exitCode: 0 },
});

test("model input follows hook execution IDs, including text-only outputs; raw captures remain separate", () => {
  const event = makeEvents();
  const fused = { id: "fused", controllerId: hook.id, mediaType: "image/png" };
  const result = aggregate([
    event("observation", { id: "raw", controllerId: "bottom", mediaType: "image/png" }),
    event("observe_hook_end", completedHook("fusion", "Two screens, fused.", [fused])),
    event("observation", fused), // Duplicate archival fact must not duplicate the frame or erase hook provenance.
    event("context", { observations: ["fused"], executions: ["fusion"] }),
    event("model_start", { observations: ["fused"] }, { modelCallId: "first" }),
    event("observe_hook_end", completedHook("text-only", "Only a text observation.", [])),
    event("context", { observations: [], executions: ["text-only"] }),
    event("model_start", { observations: [] }, { modelCallId: "second" }),
    event("observe_hook_end", { ...completedHook("failed", "Should not reach input", [{ ...fused, id: "failed-frame" }]), outcome: "error" }),
    event("context", { observations: [], executions: ["failed"] }),
    event("model_start", { observations: [] }, { modelCallId: "third" }),
    event("model_start", { observations: ["raw"] }, { modelCallId: "other", epoch: "other" }),
  ]);
  assert.deepEqual(result.observations.map((observation) => observation.id), ["raw", "fused"]);
  assert.equal(result.observations[1].origin, "observe_hook");
  assert.equal(result.observations[1].text, "Two screens, fused.");
  assert.deepEqual(result.observations[1].hook, hook);
  assert.deepEqual(result.calls.map((call) => call.inputObservations), [["fused"], [], [], ["raw"]]);
  assert.deepEqual(result.calls.map((call) => call.inputText), ["Two screens, fused.", "Only a text observation.", undefined, undefined]);
});

test("resident perception reuses snapshots but keeps each read's time, state and model input separate", () => {
  const event = makeEvents();
  const status = { state: "ready", generation: "g1", pid: 123, codeSHA: "v1" };
  const snapshot: PerceptionSnapshot = { id: "snapshot", sequence: 4, generation: "g1",
    recordedAt: new Date(0).toISOString(), sampling: { clock: "sampler", startedAtMs: 0, finishedAtMs: 20 },
    sampledAt: new Date(-1000).toISOString(), sources: [{ controller: "screen" }] };
  const output = (id: string) => ({ id, status: "completed", exitCode: 0, stdout: `read ${id}`,
    observations: [{ id: "image", mediaType: "image/png" }] });
  const records = [{ snapshot, text: "A sampled frame.", observations: output("first").observations }];
  const trace = { traceId: "trace", spanId: "read" };
  const events = [
    event("perception_status", { state: "unimplemented", generation: null }),
    event("perception_status", status),
    event("perception_observe_start", {}, trace),
    event("perception_observe_end", { status, snapshot, records, reused: false, durationMs: 20, result: output("first") }, trace),
    event("context", { observations: ["image"], executions: ["first"] }),
    event("model_start", { observations: ["image"] }, { modelCallId: "one" }),
    event("perception_observe_end", { status, snapshot, records, reused: true, durationMs: 3, result: output("second") }),
    event("context", { observations: ["image"], executions: ["second"] }),
    event("model_start", { observations: ["image"] }, { modelCallId: "two" }),
    event("perception_observe_end", { status: { state: "error", generation: "g2", error: "broken module" },
      error: "broken module", result: { id: "failure", stdout: "Perception failed", status: "failed", exitCode: 1, observations: [] } }),
    event("context", { observations: [], executions: ["failure"] }),
    event("model_start", { observations: [] }, { modelCallId: "three" }),
    event("perception_status", { state: "loading", generation: "g3" }, { epoch: "later" }),
  ];
  const result = aggregate(events);
  assert.deepEqual(result.observations.map(item => item.id), ["image"]);
  assert.equal(result.observations[0].origin, "perception");
  const [first, second, failure] = result.calls;
  assert.equal(first.inputText, "read first");
  assert.equal(first.perception?.legacyRepeated, false);
  assert.equal(perceptionAgeMs(first.perception), 4000);
  assert.equal(second.perception?.legacyRepeated, true);
  assert.equal(perceptionAgeMs(second.perception), 7000);
  assert.equal(failure.perception?.status?.state, "error");
  assert.equal(failure.inputText, "Perception failed");
  assert.equal(selectObservations(result.observations, failure, "image").observation, undefined);
  assert.equal(perceptionStatus(events)?.state, "loading");
  const telemetry = projectTelemetry(events);
  assert.equal(telemetry.perception.started, 1);
  assert.equal(telemetry.perception.durationMs.median, 20);
  assert.equal(telemetry.spans[0].outcome, "success");
  assert.equal(perceptionAgeMs({ ...first.perception!, snapshot: undefined }), null);
  assert.equal(perceptionAgeMs({ ...first.perception!, snapshot: { ...snapshot, recordedAt: "1970-01-01T00:00:00" } }), null);
  assert.deepEqual(eventObservations(event("perception_observe_end", {
    status, snapshot, result: output("legacy"),
  }))[0].perception?.snapshot, snapshot);
});

test("range inputs retain each record's time and generation; continuous samples are not model inputs", () => {
  const event = makeEvents();
  const first: PerceptionSnapshot = { id: "old", sequence: 1, generation: "old-generation",
    recordedAt: "1970-01-01T00:00:00.125Z", sampledAt: "1969-12-31T23:59:59.900Z",
    sampling: { clock: "old-clock", startedAtMs: 100, finishedAtMs: 115 } };
  const last: PerceptionSnapshot = { id: "new", sequence: 2, generation: "new-generation",
    recordedAt: "1970-01-01T00:00:00.925Z",
    sampling: { clock: "new-clock", startedAtMs: 10, finishedAtMs: 42 } };
  const records = [first, last].map(snapshot => ({ snapshot, text: snapshot.id,
    observations: [{ id: `${snapshot.id}-image`, mediaType: "image/png" }] }));
  // Archived history remains readable after a sampler error.
  const status = { state: "error", generation: "new-generation", error: "sampling stopped" };
  const query = { start: first.recordedAt, end: last.recordedAt, limit: 2 };
  const read = (id: string) => ({ status, snapshot: last, records, query, hasMore: true, nextAfter: 2,
    result: { id, status: "completed", exitCode: 0, stdout: "range text",
      observations: records.flatMap(record => record.observations) } });
  const result = aggregate([
    event("perception_sample", { snapshot: last, observations: [{ id: "producer-only", mediaType: "image/png" }] }),
    event("perception_observe_end", read("range")),
    event("context", { observations: ["old-image", "new-image"], executions: ["range"] }),
    event("model_start", { observations: ["old-image", "new-image"] }, { modelCallId: "range-call" }),
    event("perception_observe_end", read("again")),
    event("context", { observations: ["new-image"], executions: ["again"] }),
    event("model_start", { observations: ["new-image"] }, { modelCallId: "subset-call" }),
  ]);
  assert.deepEqual(result.observations.map(o => o.id), ["old-image", "new-image"]);
  assert.deepEqual(result.observations.map(o => o.perception?.snapshot), [first, last]);
  assert.deepEqual(result.observations.map(o => o.text), ["old", "new"]);
  const call = result.calls[0];
  assert.deepEqual(call.perception?.query, query);
  assert.equal(call.perception?.hasMore, true);
  assert.equal(call.perception?.nextAfter, 2);
  const oldFrame = selectObservations(result.observations, call, "old-image").observation!;
  const newFrame = selectObservations(result.observations, call, "new-image").observation!;
  assert.deepEqual(oldFrame.perception?.snapshot, first);
  assert.deepEqual(newFrame.perception?.snapshot, last);
  assert.equal(perceptionAgeMs(oldFrame.perception), 1875); // 2s read, not the later 5s reuse.
  assert.equal(perceptionAgeMs(newFrame.perception), 1075);
  assert.equal(samplingDurationMs(first), 15);
  assert.equal(samplingDurationMs(last), 32);
  assert.equal(observationTime(first.recordedAt), "08:00:00.125");
  assert.equal(observationTime(first.sampledAt), "07:59:59.900");
  assert.equal(observationTime(last.sampledAt), "未知");
  assert.equal(observationTime("1970-01-01T00:00:00"), "未知");
  const subset = selectObservations(result.observations, result.calls[1]);
  assert.deepEqual(subset.inputs.map(o => o.id), ["new-image"]);
  assert.equal(perceptionAgeMs(subset.observation?.perception), 4075);
  const html = renderToStaticMarkup(createElement(ObservationPanel, {
    data: { ...result, project: "test", run: "test" } as RunData,
    call, selectedImage: "old-image", onImage() {},
  }));
  assert.match(html, /记录时间<\/dt><dd title="1970-01-01T00:00:00.125Z">08:00:00.125/);
  assert.match(html, /采样耗时<\/dt><dd title="old-clock">15.0 ms/);
  assert.match(html, /记录代次<\/dt><dd title="old-generation">/);
  assert.match(html, /来源时刻<\/dt><dd title="1969-12-31T23:59:59.900Z">07:59:59.900/);
  assert.match(html, /<small>08:00:00.125<\/small>/);
  assert.match(html, /<small>08:00:00.925<\/small>/);
  assert.doesNotMatch(html, /producer-only/);
});

test("media conversion failures replace the input result and epoch history retains its own lifecycle", () => {
  const event = makeEvents();
  const ready = { state: "ready", generation: "first", codeSHA: "one" };
  const result = { id: "read", status: "completed", exitCode: 0, stdout: "image ready",
    observations: [{ id: "bad-image", mediaType: "image/png" }] };
  const events = [
    event("perception_status", ready, { epoch: undefined }),
    event("control", { mode: "auto" }),
    event("perception_observe_end", { status: ready, result }),
    event("perception_input_error", { status: { ...ready, state: "error" }, error: "cannot encode",
      result: { ...result, status: "failed", exitCode: 1, stdout: "cannot encode", observations: [] } }),
    event("context", { observations: [], executions: ["read"] }),
    event("model_start", { observations: [] }, { modelCallId: "model" }),
    event("control", { mode: "auto" }, { epoch: "next" }),
    event("perception_status", { state: "ready", generation: "second", codeSHA: "two" }, { epoch: undefined }),
  ];
  const data = aggregate(events), call = data.calls[0];
  assert.equal(call.inputText, "cannot encode");
  assert.equal(call.perception?.status?.state, "error");
  assert.equal(selectObservations(data.observations, call).observation, undefined);
  assert.equal(perceptionStatus(events, "current")?.generation, "first");
  assert.equal(perceptionStatus(events, "next")?.generation, "second");
});

test("media serving accepts archived perception output and preserves type and run-directory boundaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-hook-media-")));
  try {
    const runDir = join(root, "project/runs/run");
    const mediaDir = join(runDir, "observations");
    await mkdir(mediaDir, { recursive: true });
    const image = join(mediaDir, "fused.png"), outside = join(root, "outside.png");
    await writeFile(image, "archived pixels");
    await writeFile(outside, "outside run");
    await symlink(outside, join(mediaDir, "escaped.png"));
    const event = makeEvents();
    const events = [
      event("observation", { id: "raw", mediaType: "image/png", path: image }),
      event("perception_observe_end", { status: { state: "ready", generation: "one" }, result: {
        id: "fusion", status: "completed", exitCode: 0, stdout: "input", observations: [
        { id: "fused", mediaType: "image/png", path: image },
        { id: "json", mediaType: "application/json", path: image },
        { id: "html-source", mediaType: "text/html", path: image },
        { id: "unsupported", mediaType: "application/octet-stream", path: image },
        { id: "escaped", mediaType: "image/png", path: join(mediaDir, "escaped.png") },
      ] } }),
      event("observation", { id: "outside", mediaType: "image/png", path: outside }),
      event("perception_observe_end", { status: { state: "error", generation: "two" },
        result: { id: "failed", status: "failed", exitCode: 1, observations: [{ id: "failed", mediaType: "image/png", path: image }] } }),
    ];
    await writeFile(join(runDir, "manifest.json"), "{}");
    await writeFile(join(runDir, "events.jsonl"), events.map((item) => JSON.stringify(item)).join("\n") + "\n");
    for (const id of ["raw", "fused"]) {
      const media = await mediaFile("project", "run", id, root);
      assert.equal(media.bytes.toString(), "archived pixels");
      assert.equal(media.mediaType, "image/png");
    }
    for (const id of ["json", "html-source"]) {
      const media = await mediaFile("project", "run", id, root);
      assert.equal(media.bytes.toString(), "archived pixels");
      assert.equal(media.mediaType, "text/plain; charset=utf-8");
    }
    for (const id of ["unsupported", "failed"])
      await assert.rejects(mediaFile("project", "run", id, root), /未找到可展示/);
    for (const id of ["outside", "escaped"])
      await assert.rejects(mediaFile("project", "run", id, root), /必须位于当前运行目录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline media is shared across runs and resolved only within the registered workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-timeline-media-")));
  try {
    const workspace = join(root, "workspace"), timeline = join(workspace, ".rsa/timeline");
    const state = join(root, "project"), other = join(root, "other-workspace");
    await mkdir(join(timeline, "objects"), { recursive: true });
    await mkdir(join(timeline, "window"), { recursive: true });
    await mkdir(other);
    await mkdir(state);
    await writeFile(join(state, "workspace.json"), JSON.stringify({ workspace }));
    await writeFile(join(timeline, "objects/shared.png"), "one immutable original");
    await writeFile(join(timeline, "window/recent.png"), "temporary frame");
    await writeFile(join(other, "secret.png"), "other workspace");
    await symlink(join(other, "secret.png"), join(timeline, "objects/escape.png"));
    const observation = (id: string, asset: string) => ({ id, mediaType: "image/png",
      // This path is deliberately wrong: the explicit reference must own resolution.
      path: join(other, "secret.png"), timeline: { recordId: "record-one", sequence: 1, asset } });
    const event = makeEvents();
    const events = [
      event("observation", observation("shared", "objects/shared.png")),
      event("observation", observation("recent", "window/recent.png")),
      event("observation", observation("expired", "window/expired.png")),
      event("observation", observation("escape", "objects/escape.png")),
      event("observation", observation("traversal", "../../../other-workspace/secret.png")),
      event("observation", observation("absolute", join(other, "secret.png"))),
      event("observation", { id: "asset-only", mediaType: "image/png", timeline: { asset: "objects/shared.png" } }),
      event("observation", { id: "asset-only-traversal", mediaType: "image/png", timeline: { asset: "../outside.png" } }),
      event("observation", { id: "invalid-sequence", mediaType: "image/png", timeline: { asset: "objects/shared.png", sequence: 0 } }),
      event("observation", { id: "invalid-record", mediaType: "image/png", timeline: { asset: "objects/shared.png", recordId: "" } }),
      event("observation", { id: "unrecorded", mediaType: "image/png" }),
    ];
    for (const run of ["first", "second"]) {
      const runDir = join(workspace, "logs", run);
      await mkdir(runDir, { recursive: true });
      // The registry, not the manifest or event path, chooses the workspace.
      await writeFile(join(runDir, "manifest.json"), JSON.stringify({ workspace: other }));
      await writeFile(join(runDir, "events.jsonl"), events.map(item => JSON.stringify(item)).join("\n") + "\n");
      const media = await mediaFile("project", run, "shared", root);
      assert.equal(media.bytes.toString(), "one immutable original");
      assert.match(media.cacheControl, /immutable/);
    }
    assert.equal((await mediaFile("project", "first", "recent", root)).cacheControl, "no-store");
    assert.equal((await mediaFile("project", "first", "asset-only", root)).bytes.toString(), "one immutable original");
    await rm(join(timeline, "window/recent.png"));
    for (const id of ["recent", "expired"])
      await assert.rejects(mediaFile("project", "first", id, root), { code: "OBSERVATION_EXPIRED", status: 410 });
    await assert.rejects(mediaFile("project", "first", "unrecorded", root), { code: "OBSERVATION_UNRECORDED" });
    await assert.rejects(mediaFile("project", "first", "escape", root), /必须位于当前工作区时空轴内/);
    for (const id of ["traversal", "absolute", "asset-only-traversal", "invalid-sequence", "invalid-record"])
      await assert.rejects(mediaFile("project", "first", id, root), /无效的时空轴媒体引用/);
    await rm(timeline, { recursive: true });
    await symlink(other, timeline);
    await assert.rejects(mediaFile("project", "first", "shared", root), /必须位于当前工作区时空轴内/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata-only deliveries render as unrecorded without broken media requests", () => {
  const event = makeEvents();
  const result = aggregate([
    event("observation", { id: "input", controllerId: "bash", mediaType: "image/png", origin: "tool_result" }),
    event("model_start", { observations: ["input"] }, { modelCallId: "call" }),
  ]);
  assert.equal(result.observations[0].mediaStorage, "unrecorded");
  const html = renderToStaticMarkup(createElement(ObservationPanel, {
    data: { ...result, project: "test", run: "test" } as RunData,
    call: result.calls[0], onImage() {},
  }));
  assert.match(html, /未录制 · 仅保留交付记录/);
  assert.doesNotMatch(html, /<img|\/api\/media/);
  assert.equal(mediaFailureMessage(410), "观测已过期或已移除");
});

test("data-only and mixed model inputs expose lazy record details without duplicating data in projections", () => {
  for (const withImage of [false, true]) {
    const event = makeEvents();
    const status = { state: "ready", generation: "sampler" };
    const snapshots: PerceptionSnapshot[] = [1, 2].map(sequence => ({ id: `record-${sequence}`, sequence,
      timeline: { recordId: `record-${sequence}`, sequence }, generation: null,
      recordedAt: new Date(sequence * 1000).toISOString(), sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 } }));
    const media = withImage ? [{ id: "frame", mediaType: "image/png", timeline: { ...snapshots[1].timeline!, asset: "objects/frame.bin" } }] : [];
    const records = snapshots.map((snapshot, index) => ({ snapshot, text: "", observations: index ? media : [] }));
    const result = aggregate([
      event("perception_observe_end", { status, snapshot: snapshots[1], records,
        result: { id: "sensor-input", status: "completed", exitCode: 0, stdout: "", observations: media } }),
      event("context", { observations: media.map(item => item.id), executions: ["sensor-input"] }),
      event("model_start", { observations: media.map(item => item.id) }, { modelCallId: "input" }),
    ]);
    const html = renderToStaticMarkup(createElement(ObservationPanel, {
      data: { ...result, project: "test", run: "test" } as RunData, call: result.calls[0], onImage() {},
    }));
    assert.match(html, /记录 #1 · 感知数据与空间信息/);
    assert.match(html, /记录 #2 · 感知数据与空间信息/);
    assert.doesNotMatch(html, /本次请求没有可展示的输入画面|正在读取时空记录/);
    if (!withImage) assert.match(html, /本次输入包含 2 条时空记录/);
    assert.deepEqual(result.calls[0].perception?.records?.map(item => item.snapshot.timeline), snapshots.map(item => item.timeline));
  }
});

test("canonical queries attach to explicit deliveries, independently of sampler health and nearby queries", () => {
  const e = makeEvents();
  const record = (id: string, sequence: number, media: unknown[] = []) => ({ id, sequence,
    timeline: { recordId: id, sequence }, generation: "worker", recordedAt: new Date(sequence * 1000).toISOString(),
    sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 }, text: `read ${id}`, media });
  const frame = { id: "image", mediaType: "image/png", timeline: { recordId: "old", sequence: 1, asset: "objects/image.bin" } };
  const values = [
    e("perception_status", { state: "error", generation: "worker", error: "camera offline" }),
    e("perception_observe_end", { queryId: "history", ok: true, query: { id: "old" }, hasMore: false,
      records: [record("old", 1, [frame])], outcome: "success", durationMs: 7 }),
    e("perception_observe_end", { queryId: "sensor", ok: true, query: {}, hasMore: false,
      records: [record("sensor", 2)], outcome: "success" }),
    e("observation_context", { id: "delivery", origin: "explicit", observations: ["image"], queries: ["history", "sensor"] }),
    e("perception_observe_end", { queryId: "other", ok: true, query: {}, hasMore: false, records: [record("unselected", 3)] }),
    e("context", { observations: ["image"], executions: ["other"] }),
    e("model_start", { deliveryIds: ["delivery"], observations: ["wrong-image"] }, { modelCallId: "model" }),
    e("model_start", { deliveryIds: [], observations: ["wrong-image"] }, { modelCallId: "no-input" }),
    e("model_start", { deliveryIds: ["missing"], observations: ["wrong-image"] }, { modelCallId: "missing" }),
    e("perception_observe_end", { queryId: "failure", ok: false, query: {}, records: [], hasMore: false,
      error: { code: "EXPIRED", message: "history expired" }, outcome: "error" }),
  ];
  const result = aggregate(values);
  assert.deepEqual(result.calls.map(call => call.inputObservations), [["image"], [], []]);
  assert.deepEqual(result.calls.map(call => call.inputText), ["read old\n\nread sensor", undefined, undefined]);
  assert.deepEqual(result.calls[0].perceptionReads?.map(read => read.queryId), ["history", "sensor"]);
  assert.equal(result.calls[0].perceptionReads?.[0].status, undefined, "live health is not copied into query metadata");
  assert.equal(result.perception?.state, "error");
  assert.equal(result.notices.filter(notice => notice.failed).length, 1);
  assert.equal(result.notices.find(notice => notice.failed)?.text, "history expired");
  const selected = selectObservations(result.observations, result.calls[0], "image");
  assert.equal(selected.observation?.perception?.snapshot?.id, "old");
  const html = renderToStaticMarkup(createElement(ObservationPanel, {
    data: { ...result, project: "test", run: "test" } as RunData, call: result.calls[0], onImage() {},
  }));
  assert.match(html, /本次查询 · 成功/);
  assert.match(html, /记录 #1/);
  assert.match(html, /记录 #2/);
});

test("a failed delivery shows its error while keeping query source records out of the model-input panel", () => {
  const e = makeEvents(), result = aggregate([
    e("perception_observe_end", { queryId: "query", ok: true, query: {}, hasMore: false, records: [{
      id: "source", sequence: 1, text: "source not delivered", media: [{ id: "frame", mediaType: "image/png" }],
      timeline: { recordId: "source", sequence: 1 },
    }] }),
    e("perception_input_error", { queryId: "query", error: "image encoding failed" }),
    e("observation_context", { id: "delivery", queries: ["query"], observations: [] }),
    e("model_start", { deliveryIds: ["delivery"], observations: [] }, { modelCallId: "model" }),
  ]);
  const html = renderToStaticMarkup(createElement(ObservationPanel, {
    data: { ...result, project: "test", run: "test" } as RunData, call: result.calls[0], onImage() {},
  }));
  assert.match(html, /本次查询 · 成功/);
  assert.match(html, /输入交付失败/);
  assert.match(html, /image encoding failed/);
  assert.doesNotMatch(html, /source not delivered|记录 #1|<img|\/api\/media/);
});
