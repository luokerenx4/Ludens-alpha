import test from "node:test";
import assert from "node:assert/strict";
import type { BenchmarkCatalog } from "../lib/benchmarks";
import { benchmarkWorkspaceState, benchmarkHistoryState, benchmarkReferenceState, benchmarkDetailUrl,
  benchmarkGuidanceLinks, benchmarkListCommand, benchmarkTaskHelpCommand,
  clearBenchmarkResult, clearBenchmarkBaseline, clearBenchmarkFilter,
  benchmarkTaskChoices, benchmarkTaskSelection, benchmarkTaskFilter } from "../components/benchmark-onboarding";

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

test("task filters change history scope without clearing independently selected evidence", () => {
  const search = new URLSearchParams({ result: "alpha/run-1", verification: "score-1", baseline: "beta/run-2", baselineVerification: "score-2", benchCursor: "old-page" });
  const patch = benchmarkTaskFilter("fixture/task", "sha256:a");
  for (const [key, value] of Object.entries(patch)) value === null ? search.delete(key) : search.set(key, value);
  assert.equal(search.get("case"), "fixture/task");
  assert.equal(search.get("caseDigest"), "sha256:a");
  assert.equal(search.get("benchCursor"), null);
  assert.equal(search.get("result"), "alpha/run-1");
  assert.equal(search.get("verification"), "score-1");
  assert.equal(search.get("baseline"), "beta/run-2");
  assert.equal(search.get("baselineVerification"), "score-2");
});

test("task selection requires an unambiguous package and never borrows a result version", () => {
  const one = { name: "fixture/task", digest: "sha256:a", source: "repository" } as BenchmarkCatalog["tasks"][number];
  const two = { ...one, digest: "sha256:b" };
  assert.equal(benchmarkTaskSelection([one, two], null, one.digest).kind, "none");
  assert.equal(benchmarkTaskSelection([one, two], one.name, null).kind, "ambiguous");
  assert.equal(benchmarkTaskSelection([one, two], one.name, "sha256:missing").kind, "missing");
  assert.equal(benchmarkTaskSelection([one, two], one.name, two.digest).task, two);
  assert.equal(benchmarkTaskSelection([one], one.name, null).task, one);
});

test("identical task copies prefer workspace bindings exactly as the CLI resolver does", () => {
  const repository = { name: "fixture/task", digest: "sha256:a", source: "repository", bindings: [{ path: "/repo/config.json" }] } as BenchmarkCatalog["tasks"][number];
  const workspace = { ...repository, source: "workspace" as const, bindings: [{ ...repository.bindings[0]!, path: "/workspace/config.json" }] };
  const anotherVersion = { ...repository, digest: "sha256:b" };
  assert.deepEqual(benchmarkTaskChoices([repository, workspace, anotherVersion]), [workspace, anotherVersion]);
  assert.deepEqual(benchmarkTaskChoices([workspace, repository]), [workspace]);
  assert.equal(benchmarkTaskSelection([repository, workspace], repository.name, null).task, workspace);
});
