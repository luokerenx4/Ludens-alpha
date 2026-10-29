import type { Call, RunData } from "./types";

export interface RunReadScope {
  project: string;
  workspace: string;
  run: string;
  epoch: string;
  beforeCall: string;
}

export interface RunReadSnapshot {
  key: string;
  scope: RunReadScope;
  data: RunData;
}

/** Keep a request page available while reading another selection from that page. */
export function runAnalysisSnapshot(
  loaded: RunReadSnapshot | null,
  key: string,
  scope: RunReadScope,
): { overview: RunData | null; detail: RunData | null } {
  const empty = { overview: null, detail: null };
  if (!loaded || loaded.data.project !== scope.project || loaded.data.run !== scope.run) return empty;
  const previous = loaded.scope;
  // Selecting a request pins an implicit latest cycle to the cycle actually read.
  // Going back to an implicit latest cycle can instead select a newer cycle.
  const sameEpoch = previous.epoch === scope.epoch
    || (!previous.epoch && !!scope.epoch && scope.epoch === loaded.data.selectedEpoch);
  if (previous.project !== scope.project || previous.run !== scope.run
    || previous.workspace !== scope.workspace || previous.beforeCall !== scope.beforeCall
    || !sameEpoch || (!!scope.epoch && scope.epoch !== loaded.data.selectedEpoch)) return empty;
  return { overview: loaded.data, detail: loaded.key === key ? loaded.data : null };
}

/** A missing explicit request must never silently select the last request. */
export function analysisRequest(data: RunData | null, requestedCall: string): Call | undefined {
  if (!data) return undefined;
  if (requestedCall) return data.selectedCall?.id === requestedCall ? data.selectedCall
    : data.calls.find(call => call.id === requestedCall);
  return data.selectedCall ?? data.calls.at(-1);
}
