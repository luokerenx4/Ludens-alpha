import type { Call, Observation } from "../lib/types";

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
