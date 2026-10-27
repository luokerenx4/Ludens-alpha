import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRun, artifactRoot } from "./data";
import type { LogIndex } from "./log-index";
import { refreshReplay, replayBounds, replayCycle, replayItem, replayIdentity, timeKey, type FramePointer, type ReplayPointer } from "./replay-index";
import { readTimelinePayload, timelinePath, type StoredTimelineRecord } from "./timeline-record";
import { eventObservations, observationExecution } from "./observation-events";
import { readArtifact } from "../../shared/log-archive";
import type { Event } from "./types";
import type { ReplayDetail, ReplayFrame, ReplayOverview, ReplayWindow } from "./replay-types";

const PAGE = 500, MAX_WINDOW = 60_000;
export interface ReplayQuery { mode: "overview" | "window" | "detail" | "media"; epoch?: string;
  start?: number; end?: number; cursor?: string; id?: string; record?: string; sequence?: number; media?: number }
type Scope = ReplayOverview & { index: LogIndex };
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function expired(): never { return fail("记录已过期、未持久化或已移除", 410); }
const scoped = (pointer: { epoch?: string }, scope: Scope) => scope.epoch === null || pointer.epoch === scope.epoch;
const overlaps = (pointer: { startAt: number; endAt: number | null }, start: number, end: number) =>
  pointer.startAt <= end && (pointer.endAt ?? Infinity) >= start;
const mediaUrl = (scope: Scope, record: string, sequence: number, media: number) => {
  const q = new URLSearchParams({ project: scope.project, run: scope.run, mode: "media", record, sequence: String(sequence), media: String(media) });
  if (scope.epoch !== null) q.set("epoch", scope.epoch);
  return `/api/replay?${q}`;
};
function frame(pointer: FramePointer, scope: Scope): ReplayFrame {
  return { id: pointer.recordId, sequence: pointer.sequence, at: pointer.at, capability: pointer.capability,
    ...(pointer.text ? { text: pointer.text } : {}),
    media: pointer.mediaTypes.map((mediaType, index) => ({ index, mediaType, url: mediaUrl(scope, pointer.recordId, pointer.sequence, index) })) };
}

async function scopeFor(index: LogIndex, project: string, run: string, epoch?: string): Promise<Scope> {
  await refreshReplay(index, run);
  const selected = epoch ?? null;
  const bounds = replayBounds(index, selected);
  if (!bounds) fail("所选运行或周期没有时空轴记录", 404);
  const cycle = selected !== null ? replayCycle(index, selected) : {};
  return { project, run, epoch: selected, startAt: cycle.startAt ?? bounds.startAt, endAt: cycle.endAt ?? bounds.endAt,
    capabilities: [...index.store("replay-channels").entries()].map(entry => entry.capability), index };
}

type Candidate = { key: string; kind: "frame" | "item"; pointer: FramePointer | ReplayPointer };
const candidateKey = (at: number, kind: string, id: string) => `${timeKey(at)}${kind}:${id}`;
interface Cursor { scope: [string, string, string | null, number, number]; generation: string;
  after: string; events: number; frames: number }
function decodeCursor(value: string, scope: Scope, start: number, end: number): Cursor {
  try {
    if (value.length > 4096) throw new Error();
    const result = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (JSON.stringify(result.scope) !== JSON.stringify([scope.project, scope.run, scope.epoch, start, end])
      || result.generation !== scope.index.generation || typeof result.after !== "string"
      || !Number.isSafeInteger(result.events) || result.events < 0 || !Number.isSafeInteger(result.frames) || result.frames < 0)
      throw new Error();
    return result;
  } catch { return fail("回放分页游标已失效，请重新读取时间窗"); }
}
function windowData(scope: Scope, query: ReplayQuery): ReplayWindow {
  const { index } = scope, start = query.start!, end = query.end!;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end - start > MAX_WINDOW)
    fail("时间窗须为 UTC 毫秒，跨度不超过 60 秒");
  const cursor: Cursor = query.cursor ? decodeCursor(query.cursor, scope, start, end) : {
    scope: [scope.project, scope.run, scope.epoch, start, end], generation: index.generation,
    after: "", events: index.eventRevision, frames: Number(index.meta("replay:sequence") ?? 0) };
  const low = Math.max(start, scope.startAt), high = Math.min(end, scope.endAt);
  if (low > high) return { startAt: start, endAt: end, frames: [], items: [] };
  const candidates: Candidate[] = [];
  const add = (candidate: Candidate) => {
    if (candidate.key <= cursor.after) return;
    let lo = 0, hi = candidates.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (candidates[mid].key < candidate.key) lo = mid + 1; else hi = mid; }
    candidates.splice(lo, 0, candidate);
    if (candidates.length > PAGE + 1) candidates.pop();
  };
  const addFrame = (pointer: FramePointer) => add({ key: candidateKey(pointer.at, "frame", String(pointer.sequence).padStart(16, "0")), kind: "frame", pointer });
  const addItem = (pointer: ReplayPointer) => add({ key: candidateKey(pointer.startAt, "item", String(pointer.position).padStart(16, "0")), kind: "item", pointer });
  // A channel may sample independently. Keep its own last sample, not a single global previous frame.
  const previous = new Map<string, FramePointer>();
  for (const entry of index.store("replay-frame-time").entries({ afterId: timeKey(scope.startAt), beforeId: timeKey(low), reverse: true })) {
    if (entry.at < scope.startAt || entry.at >= low || entry.sequence > cursor.frames || previous.has(entry.capability)) continue;
    const pointer = index.store("replay-frames").meta(entry.itemId) as FramePointer;
    previous.set(pointer.capability, pointer);
    if (previous.size >= scope.capabilities.length) break;
  }
  for (const pointer of previous.values()) addFrame(pointer);
  for (const entry of index.store("replay-frame-time").entries({ afterId: timeKey(low), beforeId: timeKey(high + 1) })) {
    if (entry.at >= low && entry.at <= high && entry.sequence <= cursor.frames) addFrame(index.store("replay-frames").meta(entry.itemId) as FramePointer);
  }
  // Completed and unfinished spans that start before this window must remain visible.
  for (const entry of index.store("replay-spans").entries({ where: scope.epoch === null ? {} : { epoch: scope.epoch } })) {
    if (entry.startAt >= low || !overlaps(entry as ReplayPointer, low, high)) continue;
    const pointer = index.store("replay-items").meta(entry.id) as ReplayPointer;
    if (pointer.position <= cursor.events) addItem(pointer);
  }
  for (const entry of index.store("replay-time").entries({ afterId: timeKey(low), beforeId: timeKey(high + 1),
    where: scope.epoch === null ? {} : { epoch: scope.epoch } })) {
    const pointer = index.store("replay-items").meta(entry.itemId) as ReplayPointer;
    if (pointer.startAt >= low && pointer.startAt <= high && pointer.position <= cursor.events) addItem(pointer);
  }
  const page = candidates.slice(0, PAGE), more = candidates.length > PAGE;
  return { startAt: start, endAt: end,
    frames: page.filter(item => item.kind === "frame").map(item => frame(item.pointer as FramePointer, scope)),
    items: page.filter(item => item.kind === "item").map(item => replayItem(item.pointer as ReplayPointer)),
    ...(more ? { nextCursor: Buffer.from(JSON.stringify({ ...cursor, after: page.at(-1)!.key })).toString("base64url") } : {}) };
}

async function storedRecord(scope: Scope, id: string | undefined, sequence: number | undefined) {
  if (!id || !Number.isSafeInteger(sequence) || sequence! < 1) fail("无效的时空轴记录引用");
  const pointer = scope.index.store("replay-frames").meta(`frame:${sequence}`) as FramePointer | undefined;
  if (!pointer || pointer.recordId !== id || pointer.at < scope.startAt || pointer.at > scope.endAt) fail("记录不属于所选运行或周期", 404);
  if (!scope.index.archiveWorkspace) fail("工作区没有有效注册", 404);
  const root = join(scope.index.archiveWorkspace, ".rsa/timeline");
  const file = await timelinePath(root, relative(root, pointer.file)).catch(error => {
    if (error.code === "ENOENT") expired(); throw error;
  });
  return { root, record: await readTimelinePayload({ ...pointer, file }) };
}
async function expandEvent(event: Event, index: LogIndex) {
  const data = { ...event.data };
  for (const name of ["argsRef", "result", "payload", "response"])
    if (data[name]?.encoding) data[name] = await readArtifact(index.path, data[name], { media: "reference", workspace: index.archiveWorkspace });
  return { ...event, data };
}
async function itemDetail(scope: Scope, id: string | undefined): Promise<ReplayDetail> {
  if (!id || !/^event:\d+$/.test(id)) fail("无效的回放事件引用");
  const { index } = scope;
  const pointer = index.store("replay-items").meta(id) as ReplayPointer | undefined;
  if (!pointer || !scoped(pointer, scope) || !overlaps(pointer, scope.startAt, scope.endAt)) fail("事件不属于所选运行或周期", 404);
  const start = await index.store("replay-items").read<Event>(pointer);
  const events = [start];
  if (pointer.endPosition) {
    const end = await index.store("events").get<Event>(String(pointer.endPosition));
    if (end) events.push(end);
  }
  // Original request arguments are attached to the exact trace, not a nearest-time guess.
  if (pointer.track === "action" && start.trace?.traceId && start.trace.spanId) {
    const commands = await index.queryEvents({ epoch: pointer.epoch, traceId: start.trace.traceId, spanId: start.trace.spanId, types: ["command"], limit: 10 });
    events.push(...commands.map(row => row.event));
  }
  let observations: ReplayDetail["observations"];
  if (pointer.track === "model" && pointer.source.modelCallId) {
    const requests = await index.queryEvents({ epoch: pointer.epoch, model: pointer.source.modelCallId,
      types: ["model_request"], limit: 100 });
    events.push(...requests.map(row => row.event));
    observations = [];
    const inputs: Event[] = [];
    for (const position of pointer.inputPositions ?? []) {
      const input = await index.store("events").get<Event>(String(position));
      if (input) inputs.push(input);
    }
    const inputObservations = new Map(inputs.flatMap(input => eventObservations(input).map(observation => [observation.id, observation] as const)));
    for (const observationId of [...new Set<string>([...(start.data.observations ?? []), ...inputObservations.keys()])]) {
      let observation = inputObservations.get(observationId);
      if (!observation) {
        const original = await index.store("replay-observations").get<Event>(replayIdentity(pointer.epoch, observationId));
        if (original) observation = eventObservations(original).find(value => value.id === observationId);
      }
      const record = observation?.timeline;
      const prefix = replayIdentity(pointer.epoch, observationId) + ":";
      let encoded;
      for (const entry of index.store("replay-model-media").entries({ prefix,
        beforeId: prefix + String(pointer.position).padStart(16, "0"), reverse: true })) {
        if (entry.position < pointer.position) { encoded = entry; break; }
      }
      const params = encoded ? new URLSearchParams({ mode: "media", project: scope.project, run: scope.run, id: `model-media:${encoded.position}` }) : undefined;
      if (params && scope.epoch !== null) params.set("epoch", scope.epoch);
      observations.push({ id: observationId, ...(params ? { url: `/api/replay?${params}` } : {}),
        ...(record?.recordId ? { recordId: record.recordId, sequence: record.sequence } : {}) });
    }
    for (const input of inputs) {
      const perception = observationExecution(input)?.perception;
      for (const snapshot of [perception?.snapshot, ...(perception?.records?.map(record => record.snapshot) ?? [])]) {
        if (snapshot?.timeline && !observations.some(item => item.recordId === snapshot.timeline!.recordId))
          observations.push({ id: snapshot.id, recordId: snapshot.timeline.recordId, sequence: snapshot.timeline.sequence });
      }
    }
  }
  return { title: pointer.label, data: { item: replayItem(pointer), events: await Promise.all(events.map(event => expandEvent(event, index))) },
    ...(observations ? { observations } : {}) };
}
async function assetMedia(root: string, asset: string, mediaType: string) {
  const file = await timelinePath(root, asset).catch(error => {
    if (error.code === "ENOENT") expired(); throw error;
  });
  const bytes = await readFile(file).catch(error => { if (error.code === "ENOENT") expired(); throw error; });
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/wav", "audio/mpeg", "video/mp4", "video/webm"];
  return { bytes, mediaType: allowed.includes(mediaType) ? mediaType : "text/plain; charset=utf-8" };
}
async function recordMedia(root: string, record: StoredTimelineRecord, media: number | undefined) {
  if (!Number.isSafeInteger(media) || media! < 0) fail("无效的媒体序号");
  const selected = record.media?.[media!];
  if (!selected?.timeline?.asset) expired();
  if (selected.timeline.recordId !== record.id || selected.timeline.sequence !== record.sequence) fail("媒体与记录引用不匹配");
  return assetMedia(root, selected.timeline.asset, selected.mediaType);
}
async function modelMedia(scope: Scope, id: string) {
  if (!/^model-media:\d+$/.test(id)) fail("无效的模型媒体引用");
  const event = await scope.index.store("events").get<Event>(id.slice("model-media:".length));
  if (!event || event.type !== "observation_media" || !scope.index.archiveWorkspace
    || (scope.epoch !== null && event.trace?.epoch !== scope.epoch)) fail("媒体不属于所选运行或周期", 404);
  const media = event.data.modelMedia;
  if (!media?.asset || !media?.mediaType) expired();
  return assetMedia(join(scope.index.archiveWorkspace, ".rsa/timeline"), media.asset, media.mediaType);
}

/** All routes read persisted facts; no host, model, sampler or control RPC is involved. */
export async function getReplay(project: string, run: string, query: ReplayQuery, root = artifactRoot) {
  const { index, release } = await loadRun(project, run, root);
  try {
    const scope = await scopeFor(index, project, run, query.epoch);
    if (query.mode === "overview") { const { index: _, ...overview } = scope; return overview; }
    if (query.mode === "window") return windowData(scope, query);
    if (query.mode === "media" && query.id) return await modelMedia(scope, query.id);
    if (query.mode === "detail" && !query.record) return await itemDetail(scope, query.id);
    if (query.mode === "detail" || query.mode === "media") {
      const { root: timelineRoot, record } = await storedRecord(scope, query.record, query.sequence);
      return query.mode === "media" ? await recordMedia(timelineRoot, record, query.media)
        : { title: record.capability, data: record } satisfies ReplayDetail;
    }
    return fail("无效的回放查询模式");
  } finally { release(); }
}
