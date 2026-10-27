import { createHash } from "node:crypto";
import { join } from "node:path";
import { eventObservations, observationExecution } from "./observation-events";
import type { Event } from "./types";
import type { ReplayItem, ReplayTrack } from "./replay-types";
import type { LogIndex, RecordPointer } from "./log-index";
import { timelinePointers, readTimelinePayload } from "./timeline-record";

const VERSION = "5";
export const timeKey = (at: number, suffix = "") => String(Math.max(0, Math.floor(at))).padStart(16, "0") + ":" + suffix;
const time = (event: Event) => Date.parse(event.origin?.at ?? event.at);
const key = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export type ReplayPointer = RecordPointer & ReplayItem & { epoch: string; position: number; endPosition?: number };
export type FramePointer = RecordPointer & { sequence: number; at: number; capability: string; recordId: string;
  runId: string; text: string; mediaTypes: string[]; capabilityHash: string; recordHash: string };

function operation(event: Event): { key: string; track: ReplayTrack; start: boolean } | undefined {
  const epoch = event.trace?.epoch ?? "", trace = event.trace ?? {};
  if (/^model_(start|end|error)$/.test(event.type) && trace.modelCallId)
    return { key: key(epoch, "model", trace.modelCallId), track: "model", start: event.type === "model_start" };
  if (/^tool_(start|end)$/.test(event.type) && (trace.toolCallId || event.data.toolCallId))
    return { key: key(epoch, "tool", trace.toolCallId ?? event.data.toolCallId), track: "tool", start: event.type === "tool_start" };
  if (/^action_(start|end)$/.test(event.type) && event.data.actionId && trace.traceId && trace.spanId)
    return { key: key(epoch, "action", trace.traceId, trace.spanId, event.data.actionId), track: "action", start: event.type === "action_start" };
}
function outcome(event: Event) {
  const data = event.data;
  if (event.type === "model_error" || data.isError || data.error || data.outcome === "error") return "error";
  if (data.status === "interrupted" || data.aborted || data.stopReason === "aborted") return "cancelled";
  return typeof data.status === "string" ? data.status : "completed";
}
function label(event: Event, track: ReplayTrack) {
  const d = event.data;
  return String(track === "model" ? `${d.provider ?? "模型"}/${d.model ?? "调用"}`
    : track === "tool" ? `${d.toolName ?? "工具"}${d.intent ? ` · ${d.intent}` : ""}`
    : track === "action" ? d.controllerId ?? "play"
    : `${event.source?.component ?? "RSA"} · ${event.type}${typeof d.error === "string" ? ` · ${d.error}` : ""}`).slice(0, 240);
}
function source(event: Event): ReplayItem["source"] {
  const trace = event.trace ?? {};
  return { seq: event.seq, ...(trace.modelCallId ? { modelCallId: trace.modelCallId } : {}),
    ...(trace.toolCallId ? { toolCallId: trace.toolCallId } : {}), ...(trace.traceId ? { traceId: trace.traceId } : {}),
    ...(typeof event.data.actionId === "string" ? { actionId: event.data.actionId } : {}) };
}
function scopeKey(epoch: string | null) { return epoch === null ? "all" : `epoch:${epoch}`; }
export function replayBounds(index: LogIndex, epoch: string | null): { startAt: number; endAt: number } | undefined {
  const value = index.meta(`replay:bounds:${VERSION}:${scopeKey(epoch)}`);
  return value ? JSON.parse(value) : undefined;
}
function addBounds(index: LogIndex, epoch: string | null, at: number) {
  const previous = replayBounds(index, epoch);
  index.setMeta(`replay:bounds:${VERSION}:${scopeKey(epoch)}`, JSON.stringify({ startAt: Math.min(previous?.startAt ?? at, at),
    endAt: Math.max(previous?.endAt ?? at, at) }));
}

async function projectEvents(index: LogIndex) {
  let position = Number(index.meta("replay:position") ?? 0);
  while (position < index.eventRevision) {
    const batch = await index.queryEvents({ afterPosition: position, limit: 500 });
    if (!batch.length) break;
    for (const row of batch) {
      position = row.position;
      const event = row.event, at = time(event), epoch = event.trace?.epoch ?? "";
      if (!Number.isFinite(at)) continue;
      addBounds(index, null, at); addBounds(index, epoch, at);
      if (event.type === "control" && epoch) {
        const name = `replay:cycle:${VERSION}:${epoch}`;
        const cycle = JSON.parse(index.meta(name) ?? "{}");
        if (event.data.mode === "auto") cycle.startAt = at;
        else if (event.data.mode === "manual") cycle.endAt = at;
        index.setMeta(name, JSON.stringify(cycle));
      }
      const pointer = index.store("events").meta(String(position))!;
      const op = operation(event);
      if (event.type === "context") index.store("replay-contexts").reference(epoch, pointer.file, pointer.offset, pointer.length, { position });
      if (event.type === "observation_media" && typeof event.data.observationId === "string" && event.data.modelMedia)
        index.store("replay-model-media").reference(key(epoch, event.data.observationId) + ":" + String(position).padStart(16, "0"),
          pointer.file, pointer.offset, pointer.length, { position, epoch });
      const input = observationExecution(event);
      if (input?.result?.id) index.store("replay-inputs").reference(key(epoch, input.result.id), pointer.file, pointer.offset, pointer.length, { position });
      for (const observation of eventObservations(event))
        index.store("replay-observations").reference(key(epoch, observation.id), pointer.file, pointer.offset, pointer.length, { position });
      let inputPositions: number[] = [];
      if (event.type === "model_start") {
        const context = await index.store("replay-contexts").get<Event>(epoch);
        inputPositions = (context?.data.executions ?? []).flatMap((id: string) => {
          const input = index.store("replay-inputs").meta(key(epoch, id));
          return input ? [input.position] : [];
        });
      }
      const item = { id: `event:${position}`, track: op?.start ? op.track : "log", startAt: at,
        endAt: op?.start ? null : at, label: label(event, op?.start ? op.track : "log"),
        status: op?.start ? "pending" : outcome(event), source: source(event), epoch, position, inputPositions };
      index.store("replay-items").reference(item.id, pointer.file, pointer.offset, pointer.length, item);
      index.store("replay-time").reference(timeKey(at, String(position).padStart(16, "0")), pointer.file, pointer.offset, pointer.length,
        { itemId: item.id, at, epoch });
      if (op?.start) index.store("replay-spans").reference(item.id, pointer.file, pointer.offset, pointer.length,
        { startAt: at, endAt: null, epoch });
      if (event.type === "model_start")
        index.store("replay-models").reference(key(epoch, event.trace.modelCallId), pointer.file, pointer.offset, pointer.length, { position });
      if (op) {
        const relations = index.store("replay-pairs"), prior = relations.meta(op.key);
        const pair = { start: op.start ? position : prior?.start, end: op.start ? prior?.end : position };
        relations.reference(op.key, pointer.file, pointer.offset, pointer.length, pair);
        if (pair.start && pair.end) {
          const start = index.store("replay-items").meta(`event:${pair.start}`)!;
          const end = index.store("replay-items").meta(`event:${pair.end}`)!;
          const finish = pair.end === position ? event : await index.store("replay-items").read<Event>(end);
          index.store("replay-items").reference(start.id, start.file, start.offset, start.length,
            { ...start, endAt: Math.max(start.startAt, end.startAt), endPosition: pair.end, status: outcome(finish) });
          index.store("replay-spans").reference(start.id, start.file, start.offset, start.length,
            { startAt: start.startAt, endAt: Math.max(start.startAt, end.startAt), epoch });
        }
      }
    }
    index.setMeta("replay:position", position);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function projectFrames(index: LogIndex, run: string) {
  if (!index.archiveWorkspace) return;
  const root = join(index.archiveWorkspace, ".rsa/timeline");
  let sequence = Number(index.meta("replay:sequence") ?? 0), n = 0;
  for await (const entry of timelinePointers(root, sequence)) {
    const record = await readTimelinePayload(entry);
    sequence = entry.sequence;
    if (record.runId === run) {
      const id = `frame:${sequence}`;
      index.store("replay-frames").reference(id, entry.file, entry.offset, entry.length, { ...entry, id,
        recordId: record.id, runId: run, capability: record.capability, text: (record.text ?? "").slice(0, 300),
        mediaTypes: (record.media ?? []).map(media => media.mediaType) });
      index.store("replay-frame-time").reference(timeKey(entry.at, String(sequence).padStart(16, "0")), entry.file, entry.offset, entry.length,
        { itemId: id, at: entry.at, sequence, capability: record.capability });
      index.store("replay-channels").reference(record.capability, entry.file, entry.offset, entry.length, { capability: record.capability });
      addBounds(index, null, entry.at);
    }
    if (++n % 500 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  index.setMeta("replay:sequence", sequence);
}

const refreshes = new WeakMap<LogIndex, Promise<void>>();
export function refreshReplay(index: LogIndex, run: string) {
  let pending = refreshes.get(index);
  if (!pending) {
    pending = index.exclusive(async () => {
      if (index.meta("replay:version") !== VERSION) {
        // This is a disposable projection, not a second media or event archive.
        for (const name of ["replay-items", "replay-time", "replay-spans", "replay-pairs", "replay-models", "replay-frames", "replay-frame-time", "replay-channels", "replay-contexts", "replay-inputs", "replay-observations", "replay-model-media"])
          for (const entry of index.store(name).entries()) await index.store(name).delete(entry.id);
        index.setMeta("replay:position", 0); index.setMeta("replay:sequence", 0); index.setMeta("replay:version", VERSION);
      }
      await projectEvents(index);
      await projectFrames(index, run);
    }).finally(() => refreshes.delete(index));
    refreshes.set(index, pending);
  }
  return pending;
}

export function replayItem(pointer: ReplayPointer): ReplayItem {
  const { id, track, startAt, endAt, label, status, source } = pointer;
  return { id, track, startAt, endAt, label, status, source };
}

export const replayIdentity = key;

export function replayCycle(index: LogIndex, epoch: string) { return JSON.parse(index.meta(`replay:cycle:${VERSION}:${epoch}`) ?? "{}"); }
