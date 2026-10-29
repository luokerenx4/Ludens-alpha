import type { Call } from "./types";
import { requestWait } from "./transport";

export type RequestChartType = "latency" | "cache" | "body";
type ChartCall = Pick<Call, "durationMs" | "cacheHit" | "transport" | "wireBytes" | "frameBytes" | "headersMs" | "phases">;
const recorded = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Keep missing samples in place so lines never bridge an unrecorded request. */
export function requestChartSeries(calls: ChartCall[], type: RequestChartType) {
  const values = calls.map(call => {
    const value = recorded(type === "latency" ? call.durationMs : type === "cache" ? call.cacheHit
      : call.transport === "websocket" ? call.frameBytes : call.wireBytes);
    return value === null ? null : type === "latency" ? value / 1000 : type === "cache" ? value * 100 : value / 1e6;
  });
  const waitValues = calls.map(call => {
    const value = type === "latency" ? recorded(requestWait(call).ms) : null;
    return value === null ? null : value / 1000;
  });
  return { values, waitValues, hasData: values.some(value => value !== null) || waitValues.some(value => value !== null) };
}
