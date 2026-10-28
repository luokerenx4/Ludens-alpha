import type { Event, Observation, PerceptionRead, PerceptionStatus } from "./types";
import type { LogIndex } from "./log-index";

export interface ArchivedObservation {
  id: string;
  controllerId?: string;
  sensorId?: string;
  mediaType: string;
  path?: string;
  timeline?: Observation["timeline"];
  origin?: string;
  sourceSequence?: number;
  sourceSequenceDelta?: number;
  afterExecution?: { captureRequestedAfterMs: number };
  timing?: { requestedAtMs: number; receivedAtMs: number };
  text?: string;
  hook?: Observation["hook"];
  perception?: PerceptionRead;
}

function queryOk(data: Event["data"]): boolean | undefined {
  if (typeof data.queryId === "string") return typeof data.ok === "boolean" ? data.ok : undefined;
  const result = data.result;
  if (typeof result?.exitCode === "number") return result.status === "completed" && result.exitCode === 0;
  return data.outcome === "success" ? true : ["error", "cancelled"].includes(data.outcome) ? false : undefined;
}

/** Normalize historical event envelopes only at this reader boundary. */
export function perceptionRead(event: Event): PerceptionRead | null {
  if (event.type !== "perception_observe_end" && event.type !== "perception_input_error") return null;
  const { queryId, status, snapshot, records, query, hasMore, nextAfter, reused, durationMs, availability, error } = event.data;
  if (typeof queryId === "string") {
    const selected = (records ?? []).map(({ text, media, data: _data, space: _space, ...snapshot }: any) => ({
      snapshot, text: text ?? "", observations: (media ?? []).map(({ id }: ArchivedObservation) => ({ id })),
    }));
    return { at: event.at, queryId, ok: queryOk(event.data), query, records: selected, snapshot: selected.at(-1)?.snapshot,
      hasMore, nextAfter, durationMs, availability, error: typeof error === "string" ? error : error?.message };
  }
  return { at: event.at, status, snapshot, query, hasMore, nextAfter, legacyRepeated: reused, durationMs,
    ok: queryOk(event.data),
    error: typeof error === "string" ? error : error?.message,
    records: records?.map((record: NonNullable<PerceptionRead["records"]>[number]) => ({
      snapshot: record.snapshot, text: record.text,
      observations: record.observations.map(({ id }) => ({ id })),
    })),
  };
}

/** Query failure is independent of whether the live sampler is healthy. */
export function perceptionQueryFailed(event: Event): boolean {
  return event.type === "perception_observe_end" && queryOk(event.data) === false;
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
    else if (event.type === "perception_observe_end" && event.data.status) status = event.data.status;
  }
  return status;
}

export function observationInput(event: Event) {
  const perception = perceptionRead(event);
  if (perception?.queryId && event.type !== "perception_observe_end") return null;
  if (perception?.queryId) return { id: perception.queryId, perception,
    text: (event.data.records ?? []).map((record: any) => record.text).filter(Boolean).join("\n\n") || perception.error || "" };
  if (perception && event.data.result) return { id: event.data.result.id, text: event.data.result.stdout, perception };
  if (["execution", "capability_end"].includes(event.type) && event.data.observations?.length)
    return { id: event.data.executionId ?? event.data.id, text: event.data.stdout
      ?? event.data.result?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "", perception: undefined };
  const hook = successfulObserveHook(event);
  return hook ? { id: hook.result.id, text: hook.result.stdout, perception: undefined } : null;
}

/** New runs have explicit deliveries. Only old runs use their historical context association. */
export async function modelInputEvents(index: LogIndex, start: Event, position: number, signal?: AbortSignal) {
  const inputs: Event[] = [], contexts: Event[] = [], epoch = start.trace.epoch ?? null;
  if (Array.isArray(start.data.deliveryIds)) {
    const queries = new Set<string>();
    for (const deliveryId of new Set<string>(start.data.deliveryIds)) {
      const [delivery] = await index.queryEvents({ epoch, deliveryId, types: ["observation_context"],
        beforePosition: position, reverse: true, limit: 1, signal });
      if (!delivery) continue;
      contexts.push(delivery.event);
      for (const queryId of delivery.event.data.queries ?? []) queries.add(queryId);
    }
    const queryEvents: { position: number; event: Event }[] = [];
    for (const queryId of queries) {
      for (const type of ["perception_observe_end", "perception_input_error"]) {
        const [input] = await index.queryEvents({ epoch, queryId, types: [type],
          beforePosition: position, reverse: true, limit: 1, signal });
        if (input) queryEvents.push(input);
      }
    }
    inputs.push(...queryEvents.sort((a, b) => a.position - b.position).map(row => row.event));
  } else {
    const [context] = await index.queryEvents({ epoch, types: ["context"], beforePosition: position, reverse: true, limit: 1, signal });
    if (context) contexts.push(context.event);
    for (const resultId of context?.event.data.executions ?? []) {
      const [input] = await index.queryEvents({ epoch, resultId, beforePosition: position, reverse: true, limit: 1, signal });
      if (input) inputs.push(input.event);
    }
  }
  return { inputs, contexts };
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

/** Preserve explicit media references; a delivered image need not have an archive. */
export function eventObservations(event: Event): ArchivedObservation[] {
  if (event.type === "observation") return [event.data as ArchivedObservation];
  if (event.type === "execution" || event.type === "capability_end") return (event.data.observations ?? []).map((item: ArchivedObservation) => ({
    ...item, controllerId: item.controllerId ?? event.data.controllerId, origin: item.origin ?? "controller",
  }));
  const perception = perceptionRead(event);
  if (perception) {
    if (perception.queryId) {
      if (!perception.ok) return [];
      return (event.data.records ?? []).flatMap(({ media, text, data: _data, space: _space, ...snapshot }: any) =>
        (media ?? []).map((observation: ArchivedObservation) => ({ ...observation, origin: "perception", text,
          perception: { ...perception, records: undefined, snapshot } })));
    }
    const result = event.data.result;
    // A history query can succeed even while the current sampler is unavailable.
    if (result?.status !== "completed" || result.exitCode !== 0) return [];
    const { records, ...read } = perception;
    const byId = new Map(records?.flatMap(record => record.observations.map(media => [media.id, record] as const)));
    return (result.observations ?? []).map((observation: ArchivedObservation) => {
      const record = byId.get(observation.id);
      return { ...observation, origin: "perception", text: record?.text ?? result.stdout,
        perception: { ...read, snapshot: record?.snapshot ?? (records ? undefined : read.snapshot) } };
    });
  }
  const hook = successfulObserveHook(event);
  return hook ? (hook.result.observations ?? []).map((observation) => ({
    ...observation,
    origin: "observe_hook",
    text: hook.result.stdout,
    hook: hook.hook,
  })) : [];
}
