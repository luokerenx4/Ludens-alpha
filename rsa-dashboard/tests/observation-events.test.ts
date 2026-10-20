import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../lib/aggregate";
import { mediaFile } from "../lib/data";
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

test("media serving accepts successful archived hook output and preserves type and run-directory boundaries", async () => {
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
      event("observe_hook_end", completedHook("fusion", "input", [
        { id: "fused", mediaType: "image/png", path: image },
        { id: "json", mediaType: "application/json", path: image },
        { id: "html-source", mediaType: "text/html", path: image },
        { id: "unsupported", mediaType: "application/octet-stream", path: image },
        { id: "escaped", mediaType: "image/png", path: join(mediaDir, "escaped.png") },
      ])),
      event("observation", { id: "outside", mediaType: "image/png", path: outside }),
      event("observe_hook_end", { ...completedHook("failed", "", [{ id: "failed", mediaType: "image/png", path: image }]), outcome: "error" }),
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
