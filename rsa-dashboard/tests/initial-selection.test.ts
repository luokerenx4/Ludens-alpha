import { test } from "node:test";
import assert from "node:assert/strict";
import { initialSelection } from "../lib/initial-selection";
import type { Project } from "../lib/types";

const projects: Project[] = [
  { id: "first", runs: [{ id: "new", model: null, seconds: 600, provider: "test" }] },
  { id: "workspace-a", runs: ["latest", "older"].map((id) => ({ id, model: null, seconds: 600, provider: "test" })) },
];

test("pet links select the catalog project and historical run, retaining the cycle for run validation", () => {
  assert.deepEqual(initialSelection("?project=workspace-a&run=older&epoch=cycle-a", projects), {
    project: "workspace-a", run: "older", epoch: "cycle-a",
  });
});

test("missing or invalid link targets fall back without carrying a foreign cycle", () => {
  for (const search of ["", "?project=missing&run=older&epoch=cycle-a", "?project=..%2Fworkspace-a"]) {
    assert.deepEqual(initialSelection(search, projects), { project: "first", run: "", epoch: "" });
  }
  assert.deepEqual(initialSelection("?project=workspace-a&run=missing&epoch=cycle-a", projects), {
    project: "workspace-a", run: "", epoch: "",
  });
  assert.deepEqual(initialSelection("?project=workspace-a&run=older", []), { project: "", run: "", epoch: "" });
});

test("a project-only link retains follow-latest behavior", () => {
  assert.deepEqual(initialSelection("?project=workspace-a", projects), {
    project: "workspace-a", run: "", epoch: "",
  });
});
