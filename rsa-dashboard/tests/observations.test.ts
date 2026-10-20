import { test } from "node:test";
import assert from "node:assert/strict";
import { selectObservations } from "../components/observation-model";
import type { Observation } from "../lib/types";

const image = (id: string): Observation => ({
  id, at: new Date(0).toISOString(), controller: id, origin: "cli", mediaType: "image/png",
});

test("the request's processed input takes precedence over newer raw captures", () => {
  const result = selectObservations(
    [image("top"), image("bottom"), image("fused"), image("new-raw")],
    { inputObservations: ["fused"], observations: ["top", "bottom", "new-raw"] },
  );
  assert.equal(result.observation?.id, "fused");
  assert.equal(result.showingInput, true);
  assert.deepEqual(result.others.map((o) => o.id), ["top", "bottom", "new-raw"]);
});

test("text-only and missing input media never fall back to unrelated screenshots", () => {
  for (const inputObservations of [[], ["missing"]]) {
    const result = selectObservations(
      [image("raw")], { inputObservations, observations: ["raw"] },
    );
    assert.equal(result.observation, undefined);
    assert.equal(result.showingInput, true);
  }
});

test("raw frames are opt-in and stale selections do not carry across requests", () => {
  const observations = [image("old"), image("input"), image("raw")];
  const call = { inputObservations: ["input"], observations: ["raw"] };
  const explicit = selectObservations(observations, call, "raw");
  assert.equal(explicit.observation?.id, "raw");
  assert.equal(explicit.showingInput, false);
  const stale = selectObservations(observations, call, "old");
  assert.equal(stale.observation?.id, "input");
  assert.equal(stale.showingInput, true);
});
