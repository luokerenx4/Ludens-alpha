import { test } from "node:test";
import assert from "node:assert/strict";
import { videoPosition, videoNeedsSeek, videoSyncState } from "../components/replay-video-model";

test("video time follows the common axis and sparse segment tails hold the final frame", () => {
  assert.equal(videoPosition(1500, 1000), 0.5);
  assert.equal(videoPosition(500, 1000), 0);
  assert.equal(videoNeedsSeek(0.51, 0.5, false), false);
  assert.equal(videoNeedsSeek(0.55, 0.5, false), true);
  assert.equal(videoNeedsSeek(0.55, 0.5, true), false);
  assert.equal(videoNeedsSeek(1, 0.5, true), true);
});

test("1Hz playback follows the clock between samples and an ended seek cannot gate the next clip", () => {
  const sparse = { at: 6500, originAt: 0, sampledAt: 6031, duration: 10.041,
    currentTime: 6.5, readyState: 4, seeking: false, ended: false, playing: true, clockReady: true };
  const normal = videoSyncState(sparse);
  assert.equal(normal.target, 6.5); assert.equal(normal.seek, false); assert.equal(normal.play, true);
  // Real opening clip after an epoch begins at PTS 6.031. It stalled at 3.320
  // elapsed: clock 9.093, last sample/currentTime 9.041, readyState 1, ended true.
  const tail = { ...sparse, at: 9093, sampledAt: 9041, currentTime: 9.041,
    readyState: 1, seeking: true, ended: true, clockReady: false };
  assert.deepEqual(videoSyncState(tail), { target: 9.041, seek: false, ready: true, play: false });
  const held = videoSyncState({ ...tail, at: 10063, seeking: false });
  assert.equal(held.ready, true); assert.equal(held.seek, false);
  const rewind = videoSyncState({ ...tail, at: 8500, sampledAt: 8041, seeking: false, playing: false });
  assert.equal(rewind.seek, true); assert.equal(rewind.ready, false); assert.equal(rewind.target, 8.041);
});

test("the real sparse clip tail recovers to its recorded PTS and advances across EOF", () => {
  // Actual 155-frame segment: final PTS 9.979s, container duration 10.012333s.
  // Chromium was waiting at 9.984511s while the axis had frozen at the final sample.
  const tail = { at: 9979, originAt: 0, sampledAt: 9979, duration: 10.012333,
    currentTime: 9.984511, readyState: 1, seeking: false, ended: false, playing: true, clockReady: false };
  const recovery = videoSyncState(tail);
  assert.equal(recovery.target, 9.979); assert.equal(recovery.seek, true); assert.equal(recovery.ready, false);
  const decoded = videoSyncState({ ...tail, currentTime: 9.979, readyState: 2 });
  assert.equal(decoded.seek, false); assert.equal(decoded.ready, true);
  assert.equal(decoded.play, false); // Wait for the other screen, without losing play intent.
  assert.equal(videoSyncState({ ...tail, currentTime: 9.979, readyState: 2, clockReady: true }).play, true);
  const ended = videoSyncState({ ...tail, currentTime: 10.012333, readyState: 4, ended: true, clockReady: true });
  assert.equal(ended.seek, false); assert.equal(ended.ready, true); assert.equal(ended.play, false);
  const held = videoSyncState({ ...tail, at: 10100, currentTime: 10.012333, readyState: 4, ended: true, clockReady: true });
  assert.equal(held.ready, true); assert.equal(held.play, false); // Clock may reach the next recorded segment.
});

test("buffering is not a user pause, while backward seeks and explicit pauses still work", () => {
  const state = { at: 500, originAt: 0, sampledAt: 500, duration: 10,
    currentTime: 0.55, readyState: 2, seeking: false, ended: false, playing: true, clockReady: false };
  assert.equal(videoSyncState(state).seek, false); // No jump from 200ms to 15ms seek tolerance.
  assert.equal(videoSyncState({ ...state, playing: false }).seek, true);
  const waiting = videoSyncState({ ...state, currentTime: 0.5, readyState: 1 });
  assert.equal(waiting.ready, false); assert.equal(waiting.play, true);
  assert.equal(videoSyncState({ ...state, currentTime: 10, ended: true }).seek, true);
});
