import test from "node:test";
import assert from "node:assert/strict";
import type { BenchmarkCatalog } from "../lib/benchmarks";
import { benchmarkWorkspaceState, benchmarkHistoryState, benchmarkReferenceState, benchmarkDetailUrl,
  benchmarkGuidanceLinks, benchmarkListCommand, benchmarkTaskHelpCommand,
  clearBenchmarkResult, clearBenchmarkBaseline, clearBenchmarkFilter } from "../components/benchmark-onboarding";

const catalog = (patch: Partial<BenchmarkCatalog> = {}): BenchmarkCatalog => ({
  project: "alpha", projects: [{ id: "alpha", workspace: "/work/alpha" }], tasks: [], history: { trials: [], issues: [] }, issues: [], ...patch,
});
const hasTask = () => catalog({ tasks: [{ name: "fixture/check" }] as BenchmarkCatalog["tasks"] });

test("workspace discovery failure is not an empty workspace list; cached scope stays usable", () => {
  const base = { ready: true, workspace: "", catalogError: "", available: true };
  assert.equal(benchmarkWorkspaceState({ ...base, ready: false }), "loading");
  assert.equal(benchmarkWorkspaceState(base), "empty");
  assert.equal(benchmarkWorkspaceState({ ...base, catalogError: "registry failed" }), "error");
  assert.equal(benchmarkWorkspaceState({ ...base, workspace: "alpha", catalogError: "registry failed" }), "ready");
  assert.equal(benchmarkWorkspaceState({ ...base, workspace: "alpha", available: false }), "unavailable");
});

test("first-use history distinguishes missing task packages from a configured task without executions", () => {
  assert.equal(benchmarkHistoryState(catalog(), null, null), "no-tasks");
  assert.equal(benchmarkHistoryState(hasTask(), null, null), "no-runs");
  assert.equal(benchmarkHistoryState(catalog({ issues: [{ project: "alpha", error: "task manifest unreadable" }] }), null, null), "tasks-unavailable");
});

test("empty filters and old pages do not claim an empty history", () => {
  assert.equal(benchmarkHistoryState(catalog(), "missing/task", null), "filter-empty");
  assert.equal(benchmarkHistoryState(catalog(), "missing/task", "older-run"), "page-empty");
});

test("unreadable runs remain explicit even within a filter or older page", () => {
  const broken = catalog({ history: { trials: [], issues: [{ runId: "broken-run", error: "invalid JSON" }] } });
  assert.equal(benchmarkHistoryState(broken, null, null), "unreadable");
  assert.equal(benchmarkHistoryState(broken, "missing/task", "older-run"), "unreadable");
});

test("successful historical rows remain usable with no current task package or partial diagnostics", () => {
  const historical = catalog({ history: { trials: [{ runId: "historic-run" }] as BenchmarkCatalog["history"]["trials"], issues: [{ runId: "bad-run", error: "unreadable" }] }, issues: [{ project: "alpha", error: "missing current task" }] });
  assert.equal(benchmarkHistoryState(historical, "historic/task", "older-run"), "ready");
});

test("malformed selected run and baseline references never produce a loading URL", () => {
  assert.equal(benchmarkReferenceState(null), "none");
  for (const key of ["", "bad", "project/", "/run", "a/b/c", "a/b/", "../run", "project/../../outside", "project/run name"]) {
    assert.equal(benchmarkReferenceState(key), "invalid", key);
    assert.equal(benchmarkDetailUrl(key), null, key);
  }
});

test("a historical reference fetch is independent of current catalog membership", () => {
  const key = "old-workspace/run-20261030.1";
  assert.equal(benchmarkReferenceState(key), "valid");
  const url = new URL(benchmarkDetailUrl(key, "score-2", { verification: "score-1", evidence: "25" })!, "http://fixture");
  assert.equal(url.searchParams.get("project"), "old-workspace");
  assert.equal(url.searchParams.get("run"), "run-20261030.1");
  assert.equal(url.searchParams.get("verification"), "score-2");
  assert.equal(url.searchParams.get("verificationCursor"), "score-1");
  assert.equal(url.searchParams.get("evidenceCursor"), "25");
});

test("clearing a run, baseline, or task filter affects only that selection's URL fields", () => {
  assert.deepEqual(Object.keys(clearBenchmarkResult), ["result", "verification", "report", "verificationCursor", "evidenceCursor"]);
  assert.deepEqual(Object.keys(clearBenchmarkBaseline), ["baseline", "baselineVerification", "baselineReport"]);
  assert.deepEqual(Object.keys(clearBenchmarkFilter), ["case", "caseDigest", "benchCursor"]);
  assert.ok([...Object.values(clearBenchmarkResult), ...Object.values(clearBenchmarkBaseline), ...Object.values(clearBenchmarkFilter)].every(v => v === null));
});

test("guidance links preserve workspace and document language without stale result or filter parameters", () => {
  const links = benchmarkGuidanceLinks("alpha", "zh");
  const guide = new URL(links.guide, "http://fixture");
  assert.equal(guide.searchParams.get("view"), "docs");
  assert.equal(guide.searchParams.get("doc"), "reference/benchmark");
  assert.equal(guide.searchParams.get("docLang"), "zh");
  assert.equal(guide.searchParams.get("project"), "alpha");
  assert.equal(new URL(links.capabilities!, "http://fixture").searchParams.get("project"), "alpha");
  const empty = benchmarkGuidanceLinks("", "en");
  assert.equal(empty.capabilities, null);
  assert.equal(new URL(empty.quickstart, "http://fixture").searchParams.has("project"), false);
});

test("read-only preparation commands quote paths and task names, and never start an execution", () => {
  assert.equal(benchmarkListCommand("/work/it's here"), "rsa --workspace '/work/it'\\''s here' bench list");
  assert.equal(benchmarkTaskHelpCommand("/work/it's here", "fixture/task", "sha256:abc"), "rsa --workspace '/work/it'\\''s here' bench help 'fixture/task' --digest 'sha256:abc'");
});
