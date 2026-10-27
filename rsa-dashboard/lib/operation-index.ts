import { createHash } from "node:crypto";
import { positionKey, type LogIndex } from "./log-index";
import type { Event } from "./types";

/** Sparse interval directory. Event bodies remain in events.jsonl. */
export type OperationRef = { id: string; startPosition: number; endPosition?: number;
  track: "model" | "action" | "tool"; startAt: string; endAt?: string;
  status?: string; label?: string; epoch: string | null };
const TYPES = ["model_start", "model_end", "model_error", "tool_start", "tool_end", "action_start", "action_end"];
function operation(event: Event) {
  const trace = event.trace ?? {}, d = event.data, epoch = trace.epoch ?? null;
  const track = event.type.startsWith("model_") ? "model" : event.type.startsWith("tool_") ? "tool" : "action";
  const identity = track === "model" ? trace.modelCallId : track === "tool" ? trace.toolCallId ?? d.toolCallId
    : d.actionId && trace.traceId && trace.spanId ? [trace.traceId, trace.spanId, d.actionId] : undefined;
  if (!identity) return;
  return { key: createHash("sha256").update(JSON.stringify([epoch, track, identity])).digest("hex"),
    track: track as OperationRef["track"], epoch, start: event.type.endsWith("_start") };
}
function status(event: Event) {
  const d = event.data;
  if (event.type === "model_error" || d.isError || d.error || d.outcome === "error") return "error";
  if (d.status === "interrupted" || d.aborted || d.stopReason === "aborted") return "cancelled";
  return typeof d.status === "string" ? d.status : "completed";
}
export async function refreshOperationIndex(index: LogIndex, options: { maxEvents?: number; signal?: AbortSignal } = {}) {
  return index.exclusive(async () => {
    let position = Number(index.meta("operations:position") ?? 0), consumed = 0;
    const target = index.eventRevision;
    for (;;) {
      options.signal?.throwIfAborted();
      const refs = await index.queryEventRefs({ afterPosition: position, beforePosition: target + 1,
        types: TYPES, limit: Math.min(500, (options.maxEvents ?? Infinity) - consumed), signal: options.signal });
      if (!refs.length) { position = target; break; }
      for (const ref of refs) {
        const event = (await index.readEvent(ref))!, op = operation(event);
        position = ref.position;
        if (!op) continue;
        const pairs = index.store("operation-pairs"), previous = pairs.meta(op.key);
        const pair = { startPosition: op.start ? position : previous?.startPosition,
          endPosition: op.start ? previous?.endPosition : position };
        pairs.index(op.key, pair);
        if (!pair.startPosition) continue;
        const start = op.start ? event : await index.readEvent(pair.startPosition);
        const end = pair.endPosition ? (op.start ? await index.readEvent(pair.endPosition) : event) : undefined;
        if (!start) continue;
        const startAt = start.origin?.at ?? start.at, endAt = end?.origin?.at ?? end?.at;
        index.store("operations").index(positionKey(pair.startPosition), { ...pair,
          track: op.track, epoch: op.epoch, startAt,
          ...(endAt ? { endAt: new Date(Math.max(Date.parse(startAt), Date.parse(endAt))).toISOString() } : {}),
          status: end ? status(end) : "pending" });
      }
      index.setMeta("operations:position", position);
      consumed += refs.length;
      if (position >= target || consumed >= (options.maxEvents ?? Infinity)) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    index.setMeta("operations:position", position);
    return { position, complete: position >= index.eventRevision };
  });
}
export async function getOperation(index: LogIndex, startPosition: number): Promise<OperationRef | undefined> {
  return index.store("operations").meta(positionKey(startPosition)) as OperationRef | undefined;
}
export async function queryOperationRefs(index: LogIndex, options: { epoch?: string | null; start: number;
  end: number; afterPosition?: number; beforePosition?: number; limit?: number; signal?: AbortSignal }): Promise<OperationRef[]> {
  const result: OperationRef[] = [], limit = Math.max(1, Math.min(5000, options.limit ?? 500));
  let n = 0;
  for (const row of index.store("operations").entries({ afterId: positionKey(options.afterPosition ?? 0),
    ...(options.beforePosition === undefined ? {} : { beforeId: positionKey(options.beforePosition) }),
    ...(options.epoch === undefined ? {} : { where: { epoch: options.epoch } }) })) {
    if (++n % 250 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); options.signal?.throwIfAborted(); }
    let ref = row as OperationRef;
    // A terminal event received after this page's source snapshot cannot change
    // either the interval overlap or the status of a continuation page.
    if (ref.endPosition !== undefined && ref.endPosition >= (options.beforePosition ?? Infinity))
      ref = { ...ref, endPosition: undefined, endAt: undefined, status: "pending" };
    if ((options.epoch !== undefined && ref.epoch !== options.epoch) || Date.parse(ref.startAt) > options.end
      || (ref.endAt && Date.parse(ref.endAt) < options.start)) continue;
    result.push(ref);
    if (result.length >= limit) break;
  }
  options.signal?.throwIfAborted();
  return result;
}
