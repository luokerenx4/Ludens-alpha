import { test } from "node:test";
import assert from "node:assert/strict";
import { initialSelection, latestGameRun } from "../lib/initial-selection";
import { workspaceRunEntry, workspaceRunLinks } from "../lib/workspace-run-entry";
import { isPlainNavigationClick } from "../lib/dashboard-navigation";
import type { Project } from "../lib/types";

test("directory loading, failed reads and a genuinely empty directory have distinct recovery states", () => {
  const empty = { catalogReady: false, catalogError: "", run: "" };
  assert.equal(workspaceRunEntry(empty), "loading-catalog");
  assert.equal(workspaceRunEntry({ ...empty, catalogReady: true, catalogError: "offline" }), "catalog-error");
  assert.equal(workspaceRunEntry({ ...empty, catalogReady: true }), "no-workspaces");
});

test("empty and benchmark-only workspaces reach the no-game-run state instead of loading forever", () => {
  for (const runs of [[], [{ id: "evaluation", kind: "benchmark", model: null, seconds: 60, drivers: [] }]]) {
    const project: Project = { id: "workspace", runs };
    const selection = initialSelection("?view=live&project=workspace", [project]);
    const run = selection.run || latestGameRun(project)?.id || "";
    assert.equal(workspaceRunEntry({ project, run, catalogReady: true, catalogError: "" }), "no-run");
  }
});

test("explicit benchmark and historical recordings remain loadable, including during a catalog retry", () => {
  const project: Project = { id: "workspace", runs: [
    { id: "evaluation", kind: "benchmark", model: null, seconds: 60, drivers: [] },
    { id: "older", model: null, seconds: 60, drivers: [] },
  ] };
  for (const id of ["evaluation", "older"]) {
    const selection = initialSelection(`?view=replay&project=workspace&run=${id}&epoch=all`, [project]);
    assert.equal(selection.run, id);
    assert.equal(selection.epoch, "all");
    assert.equal(workspaceRunEntry({ project, run: selection.run, catalogReady: true, catalogError: "offline" }), "ready");
  }
});

test("unavailable workspace folders get recovery instead of a no-run prompt", () => {
  assert.equal(workspaceRunEntry({ project: { id: "missing", available: false, runs: [] }, run: "", catalogReady: true, catalogError: "" }), "workspace-unavailable");
});

test("empty-state actions have clean destinations and explicit benchmark context", () => {
  const links = workspaceRunLinks("my workspace", "zh", "benchmark/one");
  const params = (url: string) => Object.fromEntries(new URL(url, "http://localhost").searchParams);
  assert.deepEqual(params(links.workspaces), { view: "workspaces" });
  assert.deepEqual(params(links.capabilities!), { view: "caps", project: "my workspace" });
  assert.deepEqual(params(links.quickstart), { view: "docs", doc: "tutorials/quickstart", docLang: "zh" });
  assert.deepEqual(params(links.benchmark!), { view: "benchmark", project: "my workspace", run: "benchmark/one" });
  assert.equal(workspaceRunLinks(undefined, "en").capabilities, undefined);
  assert.equal(workspaceRunLinks(undefined, "en").benchmark, undefined);
});

test("only an unhandled primary click is intercepted for client navigation", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  assert.equal(isPlainNavigationClick(click), true);
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey", "defaultPrevented"])
    assert.equal(isPlainNavigationClick({ ...click, [key]: true }), false, key);
  for (const button of [1, 2]) assert.equal(isPlainNavigationClick({ ...click, button }), false);
});
