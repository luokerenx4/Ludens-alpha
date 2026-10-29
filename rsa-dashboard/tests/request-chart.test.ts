import { test } from "node:test";
import assert from "node:assert/strict";
import { requestChartSeries, type RequestChartType } from "../lib/request-chart";

type ChartCall = Parameters<typeof requestChartSeries>[0][number];
const sample = (patch: Partial<ChartCall> = {}): ChartCall => ({
  durationMs: null, cacheHit: null, transport: null, wireBytes: null, frameBytes: null, headersMs: null, phases: {}, ...patch,
});

test("empty and unrecorded metrics have explicit no-data state", () => {
  for (const type of ["latency", "cache", "body"] as RequestChartType[]) {
    assert.equal(requestChartSeries([], type).hasData, false);
    assert.deepEqual(requestChartSeries([sample()], type), { values: [null], waitValues: [null], hasData: false });
  }
});

test("recorded zero is meaningful for every chart, including WebSocket frame bytes", () => {
  const call = sample({ durationMs: 0, cacheHit: 0, wireBytes: 0 });
  for (const type of ["latency", "cache", "body"] as RequestChartType[])
    assert.deepEqual(requestChartSeries([call], type), { values: [0], waitValues: [null], hasData: true });
  assert.deepEqual(requestChartSeries([sample({ transport: "websocket", frameBytes: 0, wireBytes: 123 })], "body").values, [0]);
});

test("latency can show recorded HTTP or WebSocket waits without a completed total", () => {
  const calls = [sample({ transport: "sse", headersMs: 250 }), sample({ transport: "websocket", phases: { afterDispatchMs: 0 } })];
  assert.deepEqual(requestChartSeries(calls, "latency"), { values: [null, null], waitValues: [0.25, 0], hasData: true });
  assert.equal(requestChartSeries(calls, "cache").hasData, false);
  assert.equal(requestChartSeries(calls, "body").hasData, false);
});

test("unknown transport does not borrow a different waiting milestone", () => {
  assert.equal(requestChartSeries([sample({ headersMs: 100, phases: { afterDispatchMs: 200 } })], "latency").hasData, false);
  assert.deepEqual(requestChartSeries([sample({ transport: "websocket", headersMs: 100 })], "latency").waitValues, [null]);
});

test("missing samples retain alignment and units for the selected metric", () => {
  assert.deepEqual(requestChartSeries([sample({ durationMs: 1200 }), sample(), sample({ durationMs: 2500 })], "latency").values, [1.2, null, 2.5]);
  assert.deepEqual(requestChartSeries([sample({ cacheHit: 0.25 })], "cache").values, [25]);
  assert.deepEqual(requestChartSeries([sample({ transport: "sse", wireBytes: 1250000 })], "body").values, [1.25]);
});

test("non-finite data cannot produce invalid chart geometry", () => {
  const call = sample({ durationMs: NaN, cacheHit: Infinity, wireBytes: -Infinity, transport: "sse", headersMs: NaN });
  for (const type of ["latency", "cache", "body"] as RequestChartType[]) assert.equal(requestChartSeries([call], type).hasData, false);
});
