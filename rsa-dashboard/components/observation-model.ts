import type { Call, Observation, PerceptionRead, PerceptionSnapshot, PerceptionStatus } from "../lib/types";

export function perceptionStateLabel(state: PerceptionStatus["state"], t?: (key: string) => string): string {
  const key = `perceptionState.${state}`;
  const translated = t?.(key);
  if (translated && translated !== key) return translated;
  return ({ unimplemented: "尚未实现", loading: "加载中", ready: "就绪", stopped: "已停止", error: "异常" } as const)[state];
}

export function mediaFailureMessage(status: number, t?: (key: string) => string): string {
  const key = status === 409 ? "mediaFailure.writing" : status === 503 ? "mediaFailure.busy"
    : status === 410 ? "mediaFailure.expired" : "mediaFailure.unreadable";
  const translated = t?.(key);
  if (translated && translated !== key) return translated;
  if (status === 409) return "视频片段正在写入请稍后重试";
  if (status === 503) return "历史画面解码繁忙请稍后重试";
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

export function observationTime(time?: string, t?: (key: string) => string): string {
  if (!time || !Number.isFinite(timestampMs(time))) {
    const translated = t?.("common.unknown");
    return translated && translated !== "common.unknown" ? translated : "未知";
  }
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
