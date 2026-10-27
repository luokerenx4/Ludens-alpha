import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRun, artifactRoot } from "./data";
import type { LogIndex } from "./log-index";
import { refreshReplay, replayBounds, replayCycle, replayItem, replayIdentity, timeKey, videoAssetKey, type FramePointer, type ReplayPointer } from "./replay-index";
import { readTimelinePayload, timelinePath, type StoredTimelineRecord } from "./timeline-record";
import { eventObservations, observationExecution } from "./observation-events";
import { readArtifact } from "../../shared/log-archive";
import type { Event } from "./types";
import type { ReplayDetail, ReplayFrame, ReplayOverview, ReplayWindow } from "./replay-types";
import { decodeTimelineFrame, type VideoFrameReference } from "../../shared/timeline-media";
import type { FileMedia } from "./file-response";

const PAGE = 500, MAX_WINDOW = 60_000;
export interface ReplayQuery { mode: "overview" | "window" | "detail" | "media" | "segment"; epoch?: string;
  start?: number; end?: number; cursor?: string; id?: string; record?: string; sequence?: number; media?: number; asset?: string }
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
const segmentUrl = (scope: Scope, asset: string) => {
  const q = new URLSearchParams({ project: scope.project, run: scope.run, mode: "segment", asset });
  if (scope.epoch !== null) q.set("epoch", scope.epoch);
  return `/api/replay?${q}`;
};
interface VideoState { status: "pending" | "ready" | "error"; durationSeconds: number; error?: string }
async function videoState(root: string, asset: string): Promise<VideoState> {
  try {
    const state = JSON.parse(await readFile(await timelinePath(root, asset + ".json"), "utf8"));
    if (!["pending", "ready", "error"].includes(state.status)
      || !Number.isFinite(state.durationSeconds) || state.durationSeconds < 0) throw new Error("无效的视频片段状态");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "error", durationSeconds: 0, error: "视频片段已移除或未完成" };
    throw error;
  }
}
async function frame(pointer: FramePointer, scope: Scope, states: Map<string, Promise<VideoState>>): Promise<ReplayFrame> {
  return { id: pointer.recordId, sequence: pointer.sequence, at: pointer.at, capability: pointer.capability,
    ...(pointer.text ? { text: pointer.text } : {}),
    media: await Promise.all(pointer.media.map(async (media, index) => {
      const base = { index, mediaType: media.mediaType, url: mediaUrl(scope, pointer.recordId, pointer.sequence, index) };
      const reference = media.timeline, video = reference?.video;
      if (!video || !scope.index.archiveWorkspace) return base;
      let state: VideoState;
      if (video.status === "gap") state = { status: "error", durationSeconds: 0, error: video.reason ?? "此帧未被录制" };
      else {
        let pending = states.get(reference.asset);
        if (!pending) {
          pending = videoState(join(scope.index.archiveWorkspace, ".rsa/timeline"), reference.asset);
          states.set(reference.asset, pending);
        }
        state = await pending;
      }
      return { ...base, video: { url: segmentUrl(scope, reference.asset),
        originAt: pointer.at - video.pts * video.timeBase[0] / video.timeBase[1] * 1000,
        width: video.width, height: video.height, durationSeconds: state.durationSeconds,
        status: video.status === "gap" ? "gap" as const : state.status,
        ...(state.error ? { reason: state.error } : {}) } };
    })) };
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
async function windowData(scope: Scope, query: ReplayQuery): Promise<ReplayWindow> {
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
  const states = new Map<string, Promise<VideoState>>();
  return { startAt: start, endAt: end,
    frames: await Promise.all(page.filter(item => item.kind === "frame").map(item => frame(item.pointer as FramePointer, scope, states))),
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
        ...(encoded?.approximate || record?.video ? { approximate: true } : {}),
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
async function assetMedia(root: string, asset: string, mediaType: string, video?: VideoFrameReference, signal?: AbortSignal):
  Promise<FileMedia | { bytes: Buffer; mediaType: string }> {
  if (video) return { bytes: await decodeTimelineFrame(root, { asset, video }, { signal }), mediaType: "image/png" };
  const file = await timelinePath(root, asset).catch(error => {
    if (error.code === "ENOENT") expired(); throw error;
  });
  if (["video/mp4", "video/webm"].includes(mediaType)) return { file, mediaType } satisfies FileMedia;
  const bytes = await readFile(file).catch(error => { if (error.code === "ENOENT") expired(); throw error; });
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/wav", "audio/mpeg", "video/mp4", "video/webm"];
  return { bytes, mediaType: allowed.includes(mediaType) ? mediaType : "text/plain; charset=utf-8" };
}
async function recordMedia(root: string, record: StoredTimelineRecord, media: number | undefined, signal?: AbortSignal) {
  if (!Number.isSafeInteger(media) || media! < 0) fail("无效的媒体序号");
  const selected = record.media?.[media!];
  if (!selected?.timeline?.asset) expired();
  if (selected.timeline.recordId !== record.id || selected.timeline.sequence !== record.sequence) fail("媒体与记录引用不匹配");
  return assetMedia(root, selected.timeline.asset, selected.mediaType, selected.timeline.video, signal);
}
async function modelMedia(scope: Scope, id: string, signal?: AbortSignal) {
  if (!/^model-media:\d+$/.test(id)) fail("无效的模型媒体引用");
  const event = await scope.index.store("events").get<Event>(id.slice("model-media:".length));
  if (!event || event.type !== "observation_media" || !scope.index.archiveWorkspace
    || (scope.epoch !== null && event.trace?.epoch !== scope.epoch)) fail("媒体不属于所选运行或周期", 404);
  const media = event.data.modelMedia;
  if (!media?.asset || !media?.mediaType) expired();
  return assetMedia(join(scope.index.archiveWorkspace, ".rsa/timeline"), media.asset, media.mediaType, media.video, signal);
}

async function segmentMedia(scope: Scope, asset: string | undefined): Promise<FileMedia> {
  if (!asset || !/^video\/[a-zA-Z0-9_-]+\.mp4$/.test(asset) || !scope.index.archiveWorkspace) fail("无效的视频片段引用");
  const prefix = videoAssetKey(asset) + ":";
  let belongs = false;
  for (const entry of scope.index.store("replay-video-frames").entries({ afterId: prefix + timeKey(scope.startAt),
    beforeId: prefix + timeKey(scope.endAt + 1), prefix })) {
    if (entry.asset === asset && entry.at >= scope.startAt && entry.at <= scope.endAt) { belongs = true; break; }
  }
  if (!belongs) fail("视频片段不属于所选运行或周期", 404);
  const root = join(scope.index.archiveWorkspace, ".rsa/timeline"), state = await videoState(root, asset);
  if (state.status === "pending") fail("视频片段正在写入，请稍后刷新", 409);
  if (state.status !== "ready") fail(state.error ?? "视频片段未完成", 410);
  return { file: await timelinePath(root, asset), mediaType: "video/mp4", cacheControl: "private, max-age=31536000, immutable" };
}

/** All routes read persisted facts; no host, model, sampler or control RPC is involved. */
export async function getReplay(project: string, run: string, query: ReplayQuery, root = artifactRoot, signal?: AbortSignal) {
  const { index, release } = await loadRun(project, run, root);
  try {
    const scope = await scopeFor(index, project, run, query.epoch);
    if (query.mode === "overview") { const { index: _, ...overview } = scope; return overview; }
    if (query.mode === "window") return await windowData(scope, query);
    if (query.mode === "segment") return await segmentMedia(scope, query.asset);
    if (query.mode === "media" && query.id) return await modelMedia(scope, query.id, signal);
    if (query.mode === "detail" && !query.record) return await itemDetail(scope, query.id);
    if (query.mode === "detail" || query.mode === "media") {
      const { root: timelineRoot, record } = await storedRecord(scope, query.record, query.sequence);
      return query.mode === "media" ? await recordMedia(timelineRoot, record, query.media, signal)
        : { title: record.capability, data: record } satisfies ReplayDetail;
    }
    return fail("无效的回放查询模式");
  } finally { release(); }
}
