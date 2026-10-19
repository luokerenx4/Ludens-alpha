import { test } from "node:test";
import assert from "node:assert/strict";
import type { LogBlock } from "../lib/activity";
import { activityPage } from "../components/activity-feed-model";

const block = (
  id: string,
  kind: LogBlock["kind"] = "text",
  text = id,
): LogBlock => ({
  id,
  kind,
  title: id,
  text,
  at: "2026-10-19T00:00:00Z",
  status: "complete",
});

test("the latest page hides diagnostics and reveals earlier blocks in stable order", () => {
  const blocks = Array.from({ length: 230 }, (_, index) =>
    block(String(index)),
  );
  blocks.push(block("wire", "diagnostic"));
  const latest = activityPage(blocks, "all", "", 100);
  assert.equal(latest.total, 230);
  assert.equal(latest.remaining, 130);
  assert.equal(latest.page[0].id, "130");
  assert.equal(latest.page.at(-1)?.id, "229");
  assert.equal(activityPage(blocks, "all", "", 200).page[0].id, "30");
  assert.deepEqual(
    activityPage(blocks, "diagnostic", "", 100).page.map((item) => item.id),
    ["wire"],
  );
});

test("Pet deep links remain visible outside pagination and current filters without duplication", () => {
  const blocks = [block("old", "thinking"), block("new", "tool", "drive")];
  assert.equal(activityPage(blocks, "all", "", 1, "old").pinned?.id, "old");
  assert.equal(
    activityPage(blocks, "tool", "drive", 100, "old").pinned?.id,
    "old",
  );
  assert.equal(activityPage(blocks, "all", "", 100, "old").pinned, undefined);
  assert.equal(
    activityPage(blocks, "all", "", 100, "missing").missingSelection,
    true,
  );
});

test("search includes structured tool results and source without changing original blocks", () => {
  const tool = {
    ...block("call", "tool"),
    source: { component: "baseware" },
    tool: { args: { speed: 4 }, result: { accepted: true } },
  };
  const blocks = [tool, block("text")];
  assert.equal(activityPage(blocks, "all", "BASEWARE", 100).page[0], tool);
  assert.equal(activityPage(blocks, "all", "accepted", 100).page[0], tool);
  assert.equal(activityPage(blocks, "thinking", "", 100).page.length, 0);
  assert.equal(blocks.length, 2);
});
