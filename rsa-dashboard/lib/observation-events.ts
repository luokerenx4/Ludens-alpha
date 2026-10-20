import type { Event, Observation, PerceptionRead, PerceptionStatus } from "./types";

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
  perception?: PerceptionRead;
}

export function perceptionRead(event: Event): PerceptionRead | null {
  if (event.type !== "perception_observe_end" && event.type !== "perception_input_error") return null;
  const { status, snapshot, reused, durationMs, error } = event.data;
  return { at: event.at, status, snapshot, reused, durationMs, error };
}

export function perceptionStatus(events: Event[], epoch?: string | null): PerceptionStatus | null {
  let status: PerceptionStatus | null = null;
  let selected = !epoch;
  for (const event of events) {
    if (epoch && event.type === "control" && event.data.mode === "auto") {
      if (selected && event.trace.epoch !== epoch) break;
      selected ||= event.trace.epoch === epoch;
    }
    if (event.type === "perception_status") status = event.data as PerceptionStatus;
    else if (event.type === "perception_observe_end") status = event.data.status;
  }
  return status;
}

export function observationExecution(event: Event) {
  const perception = perceptionRead(event);
  if (perception) return { result: event.data.result, perception };
  const hook = successfulObserveHook(event);
  return hook ? { result: hook.result, perception: undefined } : null;
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
  const perception = perceptionRead(event);
  if (perception) {
    const result = event.data.result;
    if (perception.status.state !== "ready" || result?.status !== "completed" || result.exitCode !== 0) return [];
    return (result.observations ?? []).map((observation: ArchivedObservation) => ({
      ...observation, origin: "perception", text: result.stdout, perception,
    }));
  }
  const hook = successfulObserveHook(event);
  return hook ? (hook.result.observations ?? []).map((observation) => ({
    ...observation,
    origin: "observe_hook",
    text: hook.result.stdout,
    hook: hook.hook,
  })) : [];
}
