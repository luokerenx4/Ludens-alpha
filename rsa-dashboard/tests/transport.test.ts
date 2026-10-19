import { test } from "node:test";
import assert from "node:assert/strict";
import { medianRequestWaits, requestWait, sseFallbackReason } from "../lib/transport";
import { aggregate } from "../lib/aggregate";
import type { Call, Event } from "../lib/types";

const call = (details: Call["transportDetails"]) => ({ transport: "sse" as const, transportDetails: details });

test("fallback display uses explicit flags and never guesses an unknown or permanent cause", () => {
  assert.equal(sseFallbackReason(call(null), 0), null);
  assert.equal(sseFallbackReason(call({}), 0), null);
  assert.equal(sseFallbackReason(call({ sizeBlockedUntilCompaction: true }), 0), "尺寸阻断，等待 OMP 原生压缩");
  assert.equal(sseFallbackReason(call({ websocketDisabled: true, retryWebsocketAt: 10000 }), 0), "会话已回退");
  assert.equal(sseFallbackReason({ ...call({ sizeBlockedUntilCompaction: true }), transport: "websocket" }, 0), null);
});

test("the recorded cooldown deadline changes to next-request retry eligibility, not retry success", () => {
  const pending = call({ retryWebsocketAt: 60000 });
  assert.equal(sseFallbackReason(pending, 31000), "握手超时，60 秒冷却中（剩余 29 秒）");
  assert.equal(sseFallbackReason(pending, 59999), "握手超时，60 秒冷却中（剩余 1 秒）");
  assert.equal(sseFallbackReason(pending, 60000), "握手超时的冷却已到期，下一次请求可重试 WS");
});

test("model end updates that request's transport state without borrowing it for another request", () => {
  let seq = 0;
  const event = (modelCallId: string, type: string, data = {}): Event => ({
    seq: ++seq, type, at: new Date(seq).toISOString(), atMs: seq,
    trace: { epoch: "cycle", modelCallId }, data,
  });
  const events = [
    event("a", "model_start", { transportDetails: { sizeBlockedUntilCompaction: false } }),
    event("a", "model_http_start"),
    event("b", "model_start"),
    event("b", "model_http_start"),
    event("a", "model_end", { transportDetails: { sizeBlockedUntilCompaction: true } }),
  ];
  const [a, b] = aggregate(events).calls;
  assert.equal(sseFallbackReason(a, 0), "尺寸阻断，等待 OMP 原生压缩");
  assert.equal(sseFallbackReason(b, 0), null);
  const [cleared] = aggregate([...events,
    event("a", "model_end", { transportDetails: { sizeBlockedUntilCompaction: false } }),
  ]).calls;
  assert.equal(sseFallbackReason(cleared, 0), null);
});

test("mixed runs show HTTP and WS wait medians separately without inventing missing milestones", () => {
  let seq = 0;
  const event = (modelCallId: string, type: string, data = {}): Event => ({
    seq: ++seq, type, at: new Date(seq * 100).toISOString(), atMs: seq * 100,
    trace: { epoch: "cycle", modelCallId }, data,
  });
  const { calls } = aggregate([
    event("http", "model_start"),
    event("http", "model_http_start"),
    event("http", "model_http_end", { fetchToHeadersMs: 1800 }),
    event("http", "model_end", { durationMs: 4000 }),
    event("ws", "model_start"),
    event("ws", "model_ws_dispatch"),
    event("ws", "model_stream_start", { modelElapsedMs: 1200, afterDispatchMs: 650 }),
    event("ws", "model_end", { durationMs: 5000, firstStreamEventMs: 1200 }),
    event("missing", "model_start"),
    event("missing", "model_ws_dispatch"),
    event("missing", "model_end", { durationMs: 5000, firstStreamEventMs: 1100 }),
    event("pending", "model_start"),
    event("pending", "model_ws_dispatch"),
    event("pending", "model_stream_start", { modelElapsedMs: 5000, afterDispatchMs: 4900 }),
  ]);
  assert.deepEqual(requestWait(calls[1]), { label: "WS 首事件等待", ms: 650 });
  assert.deepEqual(requestWait(calls[2]), { label: "WS 首事件等待", ms: null });
  assert.deepEqual(medianRequestWaits(calls), [
    { label: "HTTP 响应头等待", ms: 1800 },
    { label: "WS 首事件等待", ms: 650 },
  ]);
  assert.deepEqual(medianRequestWaits(calls.slice(2)), [
    { label: "WS 首事件等待", ms: null },
  ]);
  assert.deepEqual(requestWait({ ...calls[0], transport: null }), {
    label: "等待（传输未记录）", ms: null,
  });
});
