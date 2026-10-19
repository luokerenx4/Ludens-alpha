import type { Call } from "./types";

export function requestWait(
  call: Pick<Call, "transport" | "headersMs" | "phases">,
) {
  if (call.transport === "websocket")
    return { label: "WS 首事件等待", ms: call.phases.afterDispatchMs ?? null };
  if (call.transport === "sse")
    return { label: "HTTP 响应头等待", ms: call.headersMs };
  return { label: "等待（传输未记录）", ms: null };
}

export function medianRequestWaits(calls: Call[]) {
  // These are different milestones. Keep mixed runs split by transport.
  return (["sse", "websocket"] as const).flatMap((transport) => {
    const matching = calls.filter((call) => call.transport === transport);
    if (!matching.length) return [];
    const values = matching
      .filter(
        (call) =>
          call.durationMs !== null &&
          !["aborted", "error"].includes(call.status),
      )
      .flatMap((call) => {
        const { ms } = requestWait(call);
        return ms === null ? [] : [ms];
      })
      .sort((a, b) => a - b);
    return [
      {
        label: requestWait(matching[0]).label,
        ms: values.length
          ? (values[Math.floor((values.length - 1) / 2)] +
              values[Math.floor(values.length / 2)]) /
            2
          : null,
      },
    ];
  });
}

export function sseFallbackReason(
  call: Pick<Call, "transport" | "transportDetails">,
  now: number,
): string | null {
  const details = call.transportDetails;
  if (call.transport !== "sse" || !details) return null;
  if (details.websocketDisabled) return "会话已回退";
  if (details.sizeBlockedUntilCompaction) return "尺寸阻断，等待 OMP 原生压缩";
  if (details.retryWebsocketAt !== undefined) {
    const remaining = details.retryWebsocketAt - now;
    return remaining > 0
      ? `握手超时，60 秒冷却中（剩余 ${Math.ceil(remaining / 1000)} 秒）`
      : "握手超时的冷却已到期，下一次请求可重试 WS";
  }
  return null;
}
