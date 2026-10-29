import { test } from "node:test";
import assert from "node:assert/strict";
import type { BenchmarkCatalog } from "../lib/benchmarks";
import { benchmarkCatalogOwner, benchmarkTaskMetadata, retainedBenchmarkMetadata, type BenchmarkMetadataSnapshot } from "../lib/benchmark-catalog-state";

const alpha = { project: "alpha", workspace: "/work/Alpha's workspace" };
const beta = { project: "beta", workspace: "/work/beta" };
const initial = "/api/benchmarks?project=alpha&limit=25";
const filtered = initial + "&task=fixture%2Fsecond";
const catalog = (patch: Partial<BenchmarkCatalog> = {}): BenchmarkCatalog => ({
  project: alpha.project, projects: [{ id: alpha.project, workspace: alpha.workspace }],
  tasks: [], issues: [{ project: alpha.project, error: "unreadable optional task" }],
  history: { trials: [], issues: [{ runId: "unreadable-run", error: "history error" }], nextCursor: "older-run" },
  ...patch,
});
function snapshot(): BenchmarkMetadataSnapshot {
  return { owner: benchmarkCatalogOwner(alpha)!, url: initial, metadata: benchmarkTaskMetadata(catalog(), alpha)! };
}

test("retained task metadata cannot contain history rows, errors or paging state", () => {
  const source = catalog();
  const metadata = benchmarkTaskMetadata(source, alpha);
  assert.ok(metadata);
  assert.deepEqual(Object.keys(metadata).sort(), ["issues", "project", "projects", "tasks"]);
  assert.equal("history" in metadata, false);
  assert.equal(metadata.issues, source.issues);
  assert.equal(metadata.tasks, source.tasks);
});

test("same-workspace query transitions preserve only explicitly stale inventory", () => {
  const saved = snapshot();
  const loaded = retainedBenchmarkMetadata(saved, alpha, initial, "", true);
  assert.equal(loaded.metadata, saved.metadata);
  assert.equal(loaded.metadataStale, false);
  for (const url of [filtered, filtered + "&cursor=older-run"]) {
    const pending = retainedBenchmarkMetadata(saved, alpha, url, "", false);
    assert.equal(pending.metadata, saved.metadata);
    assert.equal(pending.metadataStale, true);
    const failed = retainedBenchmarkMetadata(saved, alpha, url, "query unavailable", false);
    assert.equal(failed.metadata, saved.metadata);
    assert.equal(failed.metadataStale, true);
  }
  // Going back to the original URL does not confirm its older metadata before a new read.
  assert.equal(retainedBenchmarkMetadata(saved, alpha, initial, "", false).metadataStale, true);
  assert.equal(retainedBenchmarkMetadata(saved, alpha, initial, "read failed", true).metadataStale, true);
});

test("workspace and canonical-path changes immediately hide old metadata", () => {
  const saved = snapshot();
  for (const owner of [beta, { ...alpha, workspace: "/work/relocated-alpha" }, null]) {
    assert.deepEqual(retainedBenchmarkMetadata(saved, owner, initial, "", false), { metadata: undefined, metadataStale: false });
  }
  assert.deepEqual(retainedBenchmarkMetadata(saved, alpha, null, "", false), { metadata: undefined, metadataStale: false });
  assert.equal(benchmarkCatalogOwner({ ...alpha, workspace: "" }), null);
  assert.equal(benchmarkCatalogOwner({ ...alpha, project: "" }), null);
});

test("a response must name the expected project and canonical directory before it can supply inventory", () => {
  assert.equal(benchmarkTaskMetadata(catalog({ project: beta.project }), alpha), null);
  assert.equal(benchmarkTaskMetadata(catalog({ projects: [{ id: alpha.project, workspace: "/work/moved" }] }), alpha), null);
  assert.equal(benchmarkTaskMetadata(catalog({ projects: [{ id: beta.project, workspace: alpha.workspace }] }), alpha), null);
  assert.equal(benchmarkTaskMetadata(catalog({ project: null }), alpha), null);
});

test("successful empty inventory replaces the previous metadata without reviving an old history", () => {
  const fresh = catalog({ issues: [], history: { trials: [], issues: [] } });
  const next = { owner: benchmarkCatalogOwner(alpha)!, url: filtered, metadata: benchmarkTaskMetadata(fresh, alpha)! };
  const state = retainedBenchmarkMetadata(next, alpha, filtered, "", true);
  assert.equal(state.metadata, next.metadata);
  assert.deepEqual(state.metadata?.issues, []);
  assert.equal(state.metadataStale, false);
  assert.equal("history" in state.metadata!, false);
});
