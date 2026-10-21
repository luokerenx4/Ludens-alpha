import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_WINDOW_SIZE, acceptsScope, activitySearchText, matchesActivity,
  mergeActivity, sameScope, type ActivityBlock,
} from "../components/activity-feed-model";

const block = (id: string, revision = 1, kind: ActivityBlock["kind"] = "text"): ActivityBlock => ({
  id, kind, title: id, text: id, at: "2026-10-19T00:00:00Z", status: "complete",
  revision, createdRevision: 1,
});
const latest = { filter: "all" as const, query: "", append: true, keep: "latest" as const, limit: ACTIVITY_WINDOW_SIZE };

test("streaming updates replace a block without duplication, changed position or stale revision rollback", () => {
  const running = { ...block("call", 2, "tool"), status: "running" as const, tool: { args: { speed: 4 } } };
  const complete = { ...running, revision: 4, status: "complete" as const, tool: { ...running.tool, result: { done: true } } };
  let page = mergeActivity([block("a"), running, block("z")], [complete], latest);
  assert.deepEqual(page.map(item => item.id), ["a", "call", "z"]);
  assert.equal(page[1], complete);
  page = mergeActivity(page, [running], latest);
  assert.equal(page[1], complete);
  assert.equal(page[1].tool?.result && (page[1].tool.result as { done: boolean }).done, true);
});

test("server search and live upserts share text, type and structured tool semantics", () => {
  const tool = { ...block("call", 2, "tool"), source: { component: "baseware" },
    tool: { args: { speed: 4 }, result: { accepted: true } } };
  assert.equal(matchesActivity(tool, "all", "BASEWARE"), true);
  assert.equal(matchesActivity(tool, "tool", "accepted"), true);
  assert.equal(matchesActivity(tool, "thinking", ""), false);
  assert.equal(matchesActivity(block("wire", 1, "diagnostic"), "all", ""), false);
  assert.ok(activitySearchText(tool).includes("工具"));
  const changed = { ...tool, revision: 3, tool: { result: { rejected: true } } };
  assert.deepEqual(mergeActivity([tool], [changed], { ...latest, query: "accepted" }), []);
});

test("historical windows receive current results without appending unrelated live blocks", () => {
  const old = { ...block("old", 1, "tool"), status: "running" as const };
  const finished = { ...old, revision: 5, status: "complete" as const };
  const page = mergeActivity([old], [block("new", 6), finished], { ...latest, append: false, keep: "oldest" });
  assert.deepEqual(page, [finished]);
});

test("paging stays bounded and older pages keep their oldest records, without mutating source rows", () => {
  const rows = Array.from({ length: 300 }, (_, index) => block(String(index + 100).padStart(3, "0")));
  const older = Array.from({ length: 100 }, (_, index) => block(String(index).padStart(3, "0")));
  const page = mergeActivity(rows, older, { ...latest, keep: "oldest" });
  assert.equal(page.length, 300);
  assert.equal(page[0].id, "000");
  assert.equal(page.at(-1)?.id, "299");
  assert.equal(rows.length, 300);
  assert.equal(rows[0].id, "100");
  assert.equal(mergeActivity(rows, [block("999")], latest).at(-1)?.id, "999");
});

test("run and epoch identities reject stale responses while latest selection may follow a new cycle", () => {
  const scope = { project: "workspace", runId: "run", epoch: "epoch-2" };
  assert.equal(acceptsScope(scope, "workspace", "run"), true);
  assert.equal(acceptsScope(scope, "workspace", "run", "epoch-1"), false);
  assert.equal(acceptsScope(scope, "other", "run"), false);
  assert.equal(sameScope(scope, { ...scope, epoch: "epoch-1" }), false);
  assert.equal(sameScope(scope, { ...scope }), true);
});
