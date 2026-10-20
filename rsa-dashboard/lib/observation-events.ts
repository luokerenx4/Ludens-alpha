import type { Event, Observation } from "./types";

export interface ArchivedObservation {
  id: string;
  controllerId?: string;
  sensorId?: string;
  mediaType: string;
  path?: string;
  origin?: string;
  sourceSequence?: number;
  sourceSequenceDelta?: number;
  afterExecution?: { captureRequestedAfterMs: number };
  timing?: { requestedAtMs: number; receivedAtMs: number };
  text?: string;
  hook?: Observation["hook"];
}

export function successfulObserveHook(event: Event) {
  if (event.type !== "observe_hook_end" || event.data.outcome !== "success") return null;
  const result = event.data.result as {
    id: string;
    status: string;
    exitCode: number;
    stdout: string;
    observations?: ArchivedObservation[];
  } | undefined;
  if (!result || result.status !== "completed" || result.exitCode !== 0) return null;
  return { result, hook: event.data.hook as Observation["hook"] };
}

/** Both direct captures and workspace hook outputs archive media in the run directory. */
export function eventObservations(event: Event): ArchivedObservation[] {
  if (event.type === "observation") return [event.data as ArchivedObservation];
  const hook = successfulObserveHook(event);
  return hook ? (hook.result.observations ?? []).map((observation) => ({
    ...observation,
    origin: "observe_hook",
    text: hook.result.stdout,
    hook: hook.hook,
  })) : [];
}
