import { test } from "node:test";
import assert from "node:assert/strict";
import { videoPosition, videoNeedsSeek } from "../components/replay-video-model";

test("video time follows the common axis and sparse segment tails hold the final frame", () => {
  assert.equal(videoPosition(1500, 1000, 10), 0.5);
  assert.equal(videoPosition(500, 1000, 10), 0);
  assert.equal(videoPosition(15000, 1000, 10), 9.999);
  assert.equal(videoPosition(5000, 1000, 0), 0);
  assert.equal(videoNeedsSeek(0.51, 0.5, false), false);
  assert.equal(videoNeedsSeek(0.55, 0.5, false), true);
  assert.equal(videoNeedsSeek(0.55, 0.5, true), false);
  assert.equal(videoNeedsSeek(1, 0.5, true), true);
});
