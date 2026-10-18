import type { Call } from "./types";

export function sseFallbackReason(
  call: Pick<Call, "transport" | "transportDetails">,
  now: number,
): string | null {
  const details = call.transportDetails;
  if (call.transport !== "sse" || !details) return null;
  if (details.websocketDisabled) return "会话已回退";
  if (details.sizeBlockedUntilCompaction)
    return "尺寸阻断，等待 OMP 原生压缩";
  if (details.retryWebsocketAt !== undefined) {
    const remaining = details.retryWebsocketAt - now;
    return remaining > 0
      ? `握手超时，60 秒冷却中（剩余 ${Math.ceil(remaining / 1000)} 秒）`
      : "握手超时的冷却已到期，下一次请求可重试 WS";
  }
  return null;
}
