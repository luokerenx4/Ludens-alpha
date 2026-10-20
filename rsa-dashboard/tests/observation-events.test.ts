import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../lib/aggregate";
import { mediaFile } from "../lib/data";
import { perceptionStatus } from "../lib/observation-events";
import { perceptionAgeMs, selectObservations } from "../components/observation-model";
import { projectTelemetry } from "../lib/telemetry";
import type { Event } from "../lib/types";

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
  const snapshot = { id: "snapshot", sequence: 4, sampledAt: new Date(0).toISOString(), sources: [{ controller: "screen" }] };
  const output = (id: string) => ({ id, status: "completed", exitCode: 0, stdout: `read ${id}`,
    observations: [{ id: "image", mediaType: "image/png" }] });
  const trace = { traceId: "trace", spanId: "read" };
  const events = [
    event("perception_status", { state: "unimplemented", generation: null }),
    event("perception_status", status),
    event("perception_observe_start", {}, trace),
    event("perception_observe_end", { status, snapshot, reused: false, durationMs: 20, result: output("first") }, trace),
    event("context", { observations: ["image"], executions: ["first"] }),
    event("model_start", { observations: ["image"] }, { modelCallId: "one" }),
    event("perception_observe_end", { status, snapshot, reused: true, durationMs: 3, result: output("second") }),
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
  assert.equal(first.perception?.reused, false);
  assert.equal(perceptionAgeMs(first.perception), 4000);
  assert.equal(second.perception?.reused, true);
  assert.equal(perceptionAgeMs(second.perception), 7000);
  assert.equal(failure.perception?.status.state, "error");
  assert.equal(failure.inputText, "Perception failed");
  assert.equal(selectObservations(result.observations, failure, "image").observation, undefined);
  assert.equal(perceptionStatus(events)?.state, "loading");
  const telemetry = projectTelemetry(events);
  assert.equal(telemetry.perception.started, 1);
  assert.equal(telemetry.perception.durationMs.median, 20);
  assert.equal(telemetry.spans[0].outcome, "success");
  assert.equal(perceptionAgeMs({ ...first.perception!, snapshot: { id: "unknown", sequence: 0 } }), null);
  assert.equal(perceptionAgeMs({ ...first.perception!, snapshot: { ...snapshot, sampledAt: "1970-01-01T00:00:00" } }), null);
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
  assert.equal(call.perception?.status.state, "error");
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
