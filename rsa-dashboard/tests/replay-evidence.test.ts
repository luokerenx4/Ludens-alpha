import test from "node:test";
import assert from "node:assert/strict";
import { replayEvidenceUrl } from "../components/replay-evidence-model";

test("direct evidence URLs preserve scope and distinguish record and event identities", () => {
  const frame = new URL(replayEvidenceUrl("project=a%26b&run=run&epoch=old&id=event%3A2", { kind: "frame", record: "capture&1", sequence: 0 }), "http://localhost");
  assert.equal(frame.searchParams.get("project"), "a&b");
  assert.equal(frame.searchParams.get("epoch"), "old");
  assert.equal(frame.searchParams.get("record"), "capture&1");
  assert.equal(frame.searchParams.get("sequence"), "0");
  assert.equal(frame.searchParams.get("id"), null);
  const item = new URL(replayEvidenceUrl(frame.search, { kind: "item", id: "event:42" }), "http://localhost");
  assert.equal(item.searchParams.get("mode"), "detail");
  assert.equal(item.searchParams.get("id"), "event:42");
  assert.equal(item.searchParams.get("record"), null);
  assert.equal(item.searchParams.get("sequence"), null);
});
