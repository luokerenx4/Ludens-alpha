import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisRequest, runAnalysisSnapshot, type RunReadSnapshot, type RunReadScope } from "../lib/run-analysis-selection";
import type { Call, RunData } from "../lib/types";

const first = { id: "call-a", index: 1 } as Call;
const last = { id: "call-b", index: 2 } as Call;
const scope: RunReadScope = { project: "workspace-a", workspace: "/workspaces/a", run: "run-a", epoch: "", beforeCall: "" };
const data = { project: scope.project, run: scope.run, selectedEpoch: "cycle-a", calls: [first, last], selectedCall: last } as RunData;
const loaded: RunReadSnapshot = { key: "read-a", scope, data };

test("an exact read owns both the overview and its request details", () => {
  assert.deepEqual(runAnalysisSnapshot(loaded, loaded.key, scope), { overview: data, detail: data });
});

test("another selection can retain its page but cannot reuse the old detail read", () => {
  assert.deepEqual(runAnalysisSnapshot(loaded, "read-b", scope), { overview: data, detail: null });
  assert.equal(analysisRequest(null, "call-a"), undefined);
});

test("pinning the cycle actually read retains the page; a different cycle does not", () => {
  assert.equal(runAnalysisSnapshot(loaded, "pinned-read", { ...scope, epoch: "cycle-a" }).overview, data);
  assert.equal(runAnalysisSnapshot(loaded, "other-cycle", { ...scope, epoch: "cycle-b" }).overview, null);
  const pinned = { ...loaded, scope: { ...scope, epoch: "cycle-a" } };
  assert.equal(runAnalysisSnapshot(pinned, "new-latest", scope).overview, null);
});

test("workspace, run and page navigation never retain another scope's overview", () => {
  for (const changed of [{ project: "workspace-b" }, { workspace: "/relocated/a" }, { run: "run-b" }, { beforeCall: "20" }]) {
    assert.deepEqual(runAnalysisSnapshot(loaded, "new-scope", { ...scope, ...changed }), { overview: null, detail: null });
  }
  assert.equal(runAnalysisSnapshot(null, "read-a", scope).overview, null);
  const wrongPayload = { ...loaded, data: { ...data, project: "workspace-b" } };
  assert.equal(runAnalysisSnapshot(wrongPayload, loaded.key, scope).overview, null);
  const wrongEpoch = { ...loaded, scope: { ...scope, epoch: "cycle-b" } };
  assert.equal(runAnalysisSnapshot(wrongEpoch, loaded.key, wrongEpoch.scope).overview, null);
  assert.equal(runAnalysisSnapshot(wrongEpoch, "other-read", { ...scope, epoch: "cycle-a" }).overview, null);
});

test("explicit request resolution does not fall back to the old selected or final row", () => {
  assert.equal(analysisRequest(data, "call-a"), first);
  assert.equal(analysisRequest(data, "not-recorded"), undefined);
  assert.equal(analysisRequest(data, ""), last);
  const outsidePage = { id: "call-outside-page", index: 100 } as Call;
  assert.equal(analysisRequest({ ...data, selectedCall: outsidePage }, outsidePage.id), outsidePage);
  assert.equal(analysisRequest({ ...data, calls: [], selectedCall: undefined }, ""), undefined);
});
