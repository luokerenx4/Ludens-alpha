import { test } from "node:test";
import assert from "node:assert/strict";
import { adjacentReplayFrame, clampReplayTime, mergeReplayPages, replayFramesAt, replayItemActive,
  replayWindowBounds, retainReplayWindows } from "../components/replay-model";
import type { ReplayFrame, ReplayItem, ReplayWindow } from "../lib/replay-types";

const frame = (id: string, at: number, capability = "vision", sequence = at): ReplayFrame =>
  ({ id, at, capability, sequence, media: [] });
const window = (startAt: number, frames: ReplayFrame[] = []): ReplayWindow =>
  ({ startAt, endAt: startAt + 30_000, frames, items: [] });

test("playhead bounds use absolute time, stay in the final window and clamp invalid shares", () => {
  const range = { startAt: 1_000_000, endAt: 1_060_000 };
  assert.deepEqual(replayWindowBounds(1_045_000, range), { startAt: 1_030_000, endAt: 1_060_000 });
  assert.deepEqual(replayWindowBounds(range.endAt, range), { startAt: 1_030_000, endAt: 1_060_000 });
  assert.equal(clampReplayTime(NaN, range), range.startAt);
  assert.equal(clampReplayTime(0, range), range.startAt);
  assert.equal(clampReplayTime(Infinity, range), range.startAt);
});

test("sparse and multi-capability frames preserve the most recent past image independently", () => {
  const frames = [frame("a", 10), frame("future", 50), frame("b", 12, "depth"), frame("a2", 10, "vision", 11)];
  assert.deepEqual(replayFramesAt(frames, 20).map(f => f.id), ["b", "a2"]);
  assert.deepEqual(replayFramesAt(frames, 9), []);
  assert.deepEqual(replayFramesAt(frames, 20, "vision").map(f => f.id), ["a2"]);
  assert.equal(adjacentReplayFrame(frames, 10, 1, "vision")?.id, "future");
  assert.equal(adjacentReplayFrame(frames, 12, -1)?.at, 10);
});

test("a single-point recording has a queryable window and displays its exact frame", () => {
  const range = { startAt: 1_000, endAt: 1_000 };
  const bounds = replayWindowBounds(0, range);
  assert.deepEqual(bounds, range);
  const record = frame("only", 1_000);
  const page = mergeReplayPages([{ ...bounds, frames: [record], items: [] }]);
  assert.deepEqual(replayFramesAt(page.frames, clampReplayTime(0, range)), [record]);
  assert.equal(adjacentReplayFrame(page.frames, 1_000, -1), undefined);
  assert.equal(adjacentReplayFrame(page.frames, 1_000, 1), undefined);
});

test("window pages deduplicate overlap and the browser retains no more than two windows", () => {
  const a = window(0, [frame("prior", -1), frame("one", 1)]);
  const b = window(0, [frame("one", 1), frame("two", 2)]);
  assert.deepEqual(mergeReplayPages([a, b]).frames.map(f => f.id), ["prior", "one", "two"]);
  assert.deepEqual(retainReplayWindows([window(0), window(30_000), window(60_000), window(90_000)], 60_000)
    .map(w => w.startAt), [60_000, 90_000]);
});

test("active spans include crossed windows and open ends without claiming a completion", () => {
  const item: ReplayItem = { id: "a", track: "action", startAt: 10, endAt: 50, label: "move", source: { seq: 1 } };
  assert.equal(replayItemActive(item, 9), false);
  assert.equal(replayItemActive(item, 30), true);
  assert.equal(replayItemActive(item, 51), false);
  assert.equal(replayItemActive({ ...item, endAt: null }, 100), true);
});
