import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSelectedEvidence, latestLiveUrl, liveContext, resolveLiveSelection } from "../lib/live-follow";
import type { LiveStatus } from "../lib/types";

const paused = { location: "?view=live&project=a", project: "a", run: "run-1", requestedRun: "", epoch: "", archiveRevision: 1 };
const selection = {
  location: paused.location, project: "a", requestedRun: "", requestedEpoch: "", latestRun: "run-2",
  refresh: false, archiveRevision: 2, paused,
};
const live: LiveStatus = {
  runId: "run-2", epoch: "epoch-2", mode: "auto", connected: true, reason: "", agent: true, thinking: true,
};
const context = {
  run: "run-2", latestRun: "run-2", selectedEpoch: "epoch-2", latestEpoch: "epoch-2",
  selectedEvidence: false, historicalLog: false, live,
};

test("paused implicit selection keeps its run and defers archive invalidation", () => {
  assert.deepEqual(resolveLiveSelection(selection), { project: "a", requestedRun: "", epoch: "", run: "run-1", archiveRevision: 1, frozen: true });
  // An empty workspace must not spontaneously jump into its first run while paused.
  assert.equal(resolveLiveSelection({ ...selection, paused: { ...paused, run: "" } }).run, "");
});

test("explicit navigation while paused starts a new snapshot", () => {
  assert.deepEqual(resolveLiveSelection({ ...selection, location: "?view=live&project=a&run=older", requestedRun: "older" }),
    { project: "a", requestedRun: "older", epoch: "", run: "older", archiveRevision: 2, frozen: false });
  assert.equal(resolveLiveSelection({ ...selection, location: "?view=live&project=b", project: "b" }).run, "run-2");
});

test("resume follows the latest default but preserves an explicitly selected historical run", () => {
  assert.deepEqual(resolveLiveSelection({ ...selection, refresh: true }), { project: "a", requestedRun: "", epoch: "", run: "run-2", archiveRevision: 2, frozen: false });
  assert.equal(resolveLiveSelection({ ...selection, refresh: true, requestedRun: "older" }).run, "older");
});

test("catalog reordering cannot switch an implicit workspace while paused", () => {
  const value = resolveLiveSelection({ ...selection, location: "?view=live", project: "new-default",
    paused: { ...paused, location: "?view=live" } });
  assert.equal(value.project, "a");
  assert.equal(value.run, "run-1");
  assert.equal(value.frozen, true);
});

test("a removed catalog entry does not erase a paused explicit epoch", () => {
  const value = resolveLiveSelection({ ...selection, project: "fallback", requestedRun: "", requestedEpoch: "",
    paused: { ...paused, requestedRun: "run-1", epoch: "epoch-1" } });
  assert.equal(value.project, "a");
  assert.equal(value.requestedRun, "run-1");
  assert.equal(value.epoch, "epoch-1");
});

test("return to latest creates a clean URL for the same workspace", () => {
  const url = new URL(latestLiveUrl("workspace / 中文"), "http://localhost");
  assert.deepEqual([...url.searchParams], [["view", "live"], ["project", "workspace / 中文"]]);
  assert.equal(url.pathname, "/");
});

test("every evidence locator is recognized independently, including a block without a request", () => {
  for (const key of ["call", "beforeCall", "block", "image", "at"]) assert.equal(hasSelectedEvidence(`?${key}=one`), true);
  assert.equal(hasSelectedEvidence("?view=live&project=a&run=run-2&epoch=epoch-2"), false);
});

test("explicit newest run/epoch is still current; selected evidence and older log are distinct", () => {
  assert.deepEqual(liveContext(context), { kind: "latest", host: "auto" });
  assert.deepEqual(liveContext({ ...context, selectedEvidence: true }), { kind: "evidence", host: "auto" });
  assert.deepEqual(liveContext({ ...context, historicalLog: true }), { kind: "log", host: "auto" });
  assert.equal(liveContext({ ...context, selectedEvidence: true, historicalLog: true }).kind, "evidence");
});

test("old run and epoch take precedence over evidence and never claim an active host", () => {
  assert.deepEqual(liveContext({ ...context, run: "run-1", selectedEvidence: true }), { kind: "run", host: "historical" });
  assert.deepEqual(liveContext({ ...context, selectedEpoch: "epoch-1", selectedEvidence: true }), { kind: "epoch", host: "historical" });
});

test("manual hosts without an epoch are current, while missing or disconnected hosts are not called historical", () => {
  assert.deepEqual(liveContext({ ...context, live: { ...live, mode: "manual", epoch: null } }), { kind: "latest", host: "manual" });
  assert.deepEqual(liveContext({ ...context, live: null }), { kind: "latest", host: "unavailable" });
  assert.deepEqual(liveContext({ ...context, live: { ...live, connected: false } }), { kind: "latest", host: "disconnected" });
  assert.equal(liveContext({ ...context, live: { ...live, epoch: "other" } }).host, "unavailable");
});
