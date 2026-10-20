import type { Call, Observation, PerceptionRead, PerceptionStatus } from "../lib/types";

export const perceptionStateLabel: Record<PerceptionStatus["state"], string> = {
  unimplemented: "尚未实现",
  loading: "加载中",
  ready: "就绪",
  stopped: "已停止",
  error: "异常",
};

/** Age at the actual read, not page viewing time or media archival time. */
export function perceptionAgeMs(read?: PerceptionRead): number | null {
  if (!read?.snapshot?.sampledAt) return null;
  if (![read.at, read.snapshot.sampledAt].every(time => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(time))) return null;
  const age = Date.parse(read.at) - Date.parse(read.snapshot.sampledAt);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

export function selectObservations(
  observations: Observation[],
  call?: Pick<Call, "inputObservations" | "observations">,
  selectedId?: string,
) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const resolve = (ids: string[]) =>
    [...new Set(ids)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const inputs = resolve(call?.inputObservations ?? []);
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
