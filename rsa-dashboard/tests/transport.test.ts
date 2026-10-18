import { test } from "node:test";
import assert from "node:assert/strict";
import { sseFallbackReason } from "../lib/transport";
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
