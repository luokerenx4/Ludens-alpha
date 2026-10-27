import type { Event } from "./types";
import { projectTelemetry, telemetryOperations } from "./telemetry";

/** Small lifecycle facts only. Arguments, results and diagnostic text stay in the source. */
export type TelemetryState = { trace: Event["trace"]; starts: Record<string, Event>; ends: Record<string, Event>;
  nativeEnd?: Event };
/** Completed lifetimes retain source locators rather than a second set of event clocks and identities. */
export type TelemetryRecipe = { trace: Event["trace"]; starts: Record<string, number>; ends: Record<string, number>;
  nativeEnd?: number };
export function telemetryFactKeys(event: Event) {
  const starts: string[] = [], ends: string[] = [];
  for (const definition of telemetryOperations) {
    const key = definition.start === "action_start" ? `${definition.start}:${event.data.actionId}` : definition.start;
    if (event.type === definition.start && (!definition.startStage || definition.startStage === event.data.stage)) starts.push(key);
    if (definition.ends.includes(event.type) && (!definition.endStages || definition.endStages.includes(event.data.stage))) ends.push(key);
  }
  return { starts, ends, native: event.type === "shiori_run_end" };
}
const fields = ["stage", "actionId", "operation", "outcome", "durationMs", "aborted", "errorMessage", "error", "status", "timing"] as const;
function compact(event: Event): Event {
  const data: Record<string, any> = {};
  for (const key of fields) if (event.data[key] !== undefined) {
    const value = event.data[key];
    // Only truthiness of errors affects lifecycle statistics. Full errors are hydrated on demand.
    data[key] = key === "error" || key === "errorMessage" ? !!value
      : key === "status" && value && typeof value === "object" ? { state: value.state }
      : key === "timing" && value ? { clock: value.clock, submittedAtMs: value.submittedAtMs, receivedAtMs: value.receivedAtMs }
      : value;
  }
  return { seq: event.seq, at: event.at, atMs: event.atMs, type: event.type, trace: event.trace,
    ...(event.origin ? { origin: { at: event.origin.at, atMs: event.origin.atMs, clockId: event.origin.clockId } as Event["origin"] } : {}), data };
}

/** The same fixed-size merge is used by cold scan and append maintenance. */
export function advanceTelemetry(previous: TelemetryState | undefined, event: Event): TelemetryState | undefined {
  const trace = { ...previous?.trace, ...event.trace };
  const state: TelemetryState = previous ?? { trace, starts: {}, ends: {} };
  let changed = !previous || JSON.stringify(state.trace) !== JSON.stringify(trace);
  state.trace = trace;
  const facts = telemetryFactKeys(event);
  for (const key of facts.starts) { state.starts[key] = compact(event); changed = true; }
  for (const key of facts.ends) if (!state.ends[key]) { state.ends[key] = compact(event); changed = true; }
  if (facts.native) {
    state.nativeEnd = { ...compact(event), source: event.source, data: { summary: event.data.summary ?? {}, coverage: event.data.coverage ?? {} } };
    changed = true;
  }
  return changed ? state : undefined;
}

export function telemetryFromState(state: TelemetryState) {
  const starts = Object.values(state.starts);
  // A later explicit relation can supply the model identity to an earlier native start.
  const relation = { ...(starts[0] ?? Object.values(state.ends)[0]), type: "relation", trace: state.trace, data: {} } as Event;
  return projectTelemetry(starts, [...starts, ...Object.values(state.ends), ...(state.nativeEnd ? [state.nativeEnd] : []), relation]);
}
