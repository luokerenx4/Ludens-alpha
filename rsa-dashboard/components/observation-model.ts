import type { Call, Observation, PerceptionRead, PerceptionSnapshot, PerceptionStatus } from "../lib/types";

export const perceptionStateLabel: Record<PerceptionStatus["state"], string> = {
  unimplemented: "尚未实现",
  loading: "加载中",
  ready: "就绪",
  stopped: "已停止",
  error: "异常",
};

export function mediaFailureMessage(status: number): string {
  if (status === 409) return "视频片段正在写入，请稍后重试";
  if (status === 503) return "历史画面解码繁忙，请稍后重试";
  return status === 410 ? "观测已过期或已移除" : "无法读取观测文件";
}

/** Age at the actual read, not page viewing time or media archival time. */
export function perceptionAgeMs(read?: PerceptionRead): number | null {
  if (!read?.snapshot?.recordedAt) return null;
  const age = timestampMs(read.at) - timestampMs(read.snapshot.recordedAt);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function timestampMs(time: string): number {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(time) ? Date.parse(time) : NaN;
}

export function observationTime(time?: string): string {
  if (!time || !Number.isFinite(timestampMs(time))) return "未知";
  return new Date(time).toLocaleTimeString("zh-CN", {
    hour12: false, timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export function samplingDurationMs(snapshot?: PerceptionSnapshot): number | null {
  if (!snapshot?.sampling) return null;
  const { startedAtMs, finishedAtMs } = snapshot.sampling;
  const elapsed = finishedAtMs - startedAtMs;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function selectObservations(
  observations: Observation[],
  call?: Pick<Call, "inputObservations" | "observations" | "perception" | "perceptionReads">,
  selectedId?: string,
) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const resolve = (ids: string[]) =>
    [...new Set(ids)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const inputs = resolve(call?.inputObservations ?? []).map(observation => {
    const selectedRead = (call?.perceptionReads ?? []).findLast(read =>
      !read.deliveryError && read.records?.some(record => record.observations.some(media => media.id === observation.id))) ?? call?.perception;
    if (!selectedRead) return observation;
    const { records, ...read } = selectedRead;
    const record = records?.find(record => record.observations.some(media => media.id === observation.id));
    // The current request owns the read time; the matching record owns frame metadata.
    return { ...observation, text: record?.text,
      perception: { ...read, snapshot: record?.snapshot ?? (records ? undefined : read.snapshot) } };
  });
  const others = call
    ? resolve(call.observations.filter((id) => !call.inputObservations.includes(id)))
    : observations.slice(-4);
  // A selection from another request must not pin a stale frame over the current input.
  const explicit = [...inputs, ...others].find((observation) => observation.id === selectedId);
  return {
    inputs,
    others,
    observation: explicit ?? inputs[0],
    showingInput: !explicit || inputs.includes(explicit),
  };
}
