import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openRun, globalHome } from "./data";
import { type EventRef, type LogIndex } from "./log-index";
import { getOperation, queryOperationRefs, refreshOperationIndex, type OperationRef } from "./operation-index";
import { timelineRecord, timelinePath, timelineWindow, type StoredTimelineRecord, type TimelineCursor } from "./timeline-record";
import { eventObservations, modelInputEvents } from "./observation-events";
import { aggregate } from "./aggregate";
import { readArtifact } from "../../shared/log-archive";
import type { Event } from "./types";
import type { ReplayCoverage, ReplayDetail, ReplayFrame, ReplayItem, ReplayOverview, ReplayOverviewResult, ReplayPreparing, ReplayWindow } from "./replay-types";
import { decodeTimelineFrame, type VideoFrameReference } from "../../shared/timeline-media";
import { archiveBuildState } from "./cold-build";
import type { FileMedia } from "./file-response";

const PAGE = 500, MAX_WINDOW = 60_000, INDEX_BATCH = 4 * 1024 * 1024;
export interface ReplayQuery { mode: "overview" | "frames" | "events" | "detail" | "media" | "segment"; epoch?: string;
  start?: number; end?: number; cursor?: string; id?: string; record?: string; sequence?: number; media?: number; asset?: string; bytes?: number }
type Scope = ReplayOverview & { index: LogIndex; signal?: AbortSignal };
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function expired(): never { return fail("记录已过期、未持久化或已移除", 410); }
const at = (event: Event) => Date.parse(event.origin?.at ?? event.at);
const scoped = (event: Event, epoch: string | null) => epoch === null || event.trace?.epoch === epoch;
const url = (scope: Pick<Scope, "project" | "run" | "epoch">, values: Record<string, string | number>) => {
  const q = new URLSearchParams({ project: scope.project, run: scope.run, ...(scope.epoch === null ? {} : { epoch: scope.epoch }),
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) });
  return `/api/replay?${q}`;
};

/** A short source-index batch makes progress visible without waiting for unrelated projections. */
async function scopeFor(index: LogIndex, project: string, run: string, epoch: string | undefined, refresh: boolean, signal?: AbortSignal): Promise<Scope | ReplayPreparing> {
  const build = archiveBuildState(index);
  const building = build?.state === "queued" || build?.state === "building";
  if (!building && (refresh || !index.eventRevision)) await index.refreshEvents({ maxBytes: INDEX_BATCH, signal });
  const controls: { position: number; epoch?: string; at: string; mode: unknown }[] = [];
  let position = 0;
  for (;;) {
    const page = await index.queryEvents({ types: ["control"], afterPosition: position, limit: 500, signal });
    if (!page.length) break;
    for (const row of page) controls.push({ position: row.position, epoch: row.event.trace?.epoch,
      at: row.event.origin?.at ?? row.event.at, mode: row.event.data.mode });
    position = page.at(-1)!.position;
  }
  // The unpublished directory stays private. Only its small scanned bounds are
  // needed to read original timeline media while statistics are still building.
  if (building && build.replayHint) {
    for (const row of build.replayHint.controls) if (!controls.some(value => value.position === row.position)) controls.push(row);
    controls.sort((a, b) => a.position - b.position);
  }
  const cycles: ReplayOverview["cycles"] = [];
  for (const row of controls) if (row.mode === "auto" && row.epoch && !cycles.some(cycle => cycle.epoch === row.epoch))
    cycles.push({ epoch: row.epoch, startedAt: row.at });
  const selected = epoch === "latest" ? cycles.at(-1)?.epoch ?? null : epoch === "all" ? null : epoch ?? null;
  const coverage: ReplayCoverage = building
    ? { bytes: build.bytes ?? 0, totalBytes: build.totalBytes ?? index.progress.totalBytes, complete: false }
    : { ...index.progress };
  const bounds = { ...index.timeBounds };
  if (building && build.replayHint) {
    const hint = build.replayHint;
    if (hint.startAt && (!bounds.startAt || hint.startAt < bounds.startAt)) bounds.startAt = hint.startAt;
    if (hint.endAt && (!bounds.endAt || hint.endAt > bounds.endAt)) bounds.endAt = hint.endAt;
  }
  let startAt: number | undefined = bounds.startAt ? Date.parse(bounds.startAt) : undefined;
  let endAt: number | undefined = bounds.endAt ? Date.parse(bounds.endAt) : undefined;
  if (selected !== null) {
    const start = controls.find(row => row.epoch === selected && row.mode === "auto");
    const end = start && controls.find(row => row.position > start.position && row.epoch === selected && row.mode === "manual");
    startAt = start ? Date.parse(start.at) : undefined;
    if (end) endAt = Date.parse(end.at);
  }
  coverage.throughAt = bounds.endAt ? Date.parse(bounds.endAt) : undefined;
  if (startAt === undefined || endAt === undefined) {
    if (coverage.complete) fail("所选运行或周期没有时空轴记录", 404);
    return { project, run, epoch: selected, cycles, startAt: null, endAt: null, capabilities: [], coverage };
  }
  return { project, run, epoch: selected, cycles, startAt, endAt: Math.max(startAt, endAt), capabilities: [], coverage, index, signal };
}
function ready(value: Scope | ReplayPreparing): Scope {
  if (value.startAt === null) fail("正在读取运行边界，请稍后重试", 409);
  return value;
}

interface VideoState { status: "pending" | "ready" | "error"; format?: string; durationSeconds: number; error?: string;
  readableBytes?: number; lastReadablePts?: number | null }
async function videoState(root: string, asset: string, signal?: AbortSignal): Promise<VideoState> {
  try {
    const state = JSON.parse(await readFile(await timelinePath(root, asset + ".json"), { encoding: "utf8", signal }));
    if (!["pending", "ready", "error"].includes(state.status) || !Number.isFinite(state.durationSeconds) || state.durationSeconds < 0)
      throw new Error("无效的视频片段状态");
    if (state.format === "fmp4" && (state.readableBytes !== undefined && (!Number.isSafeInteger(state.readableBytes) || state.readableBytes < 0)
      || state.lastReadablePts !== undefined && state.lastReadablePts !== null && (!Number.isSafeInteger(state.lastReadablePts) || state.lastReadablePts < 0)))
      throw new Error("无效的视频片段读取进度");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "error", durationSeconds: 0, error: "视频片段已移除或未完成" };
    throw error;
  }
}
function readableFrame(state: VideoState, video: VideoFrameReference): boolean {
  return state.format === "fmp4" && (state.readableBytes ?? 0) > 0 && typeof state.lastReadablePts === "number"
    && video.pts * video.timeBase[0] / video.timeBase[1] <= state.lastReadablePts / 1_000_000;
}
async function frame(record: StoredTimelineRecord, scope: Scope, states: Map<string, Promise<VideoState>>): Promise<ReplayFrame> {
  const time = Date.parse(record.recordedAt);
  return { id: record.id, sequence: record.sequence, at: time, capability: record.capability, ...(record.text ? { text: record.text.slice(0, 300) } : {}),
    media: await Promise.all((record.media ?? []).map(async (media, mediaIndex) => {
      const proof = { record: record.id, sequence: record.sequence, media: mediaIndex };
      const base = { index: mediaIndex, mediaType: media.mediaType, url: url(scope, { mode: "media", ...proof }) };
      const reference = media.timeline, video = reference?.video;
      if (!video || !scope.index.archiveWorkspace) return base;
      let state: VideoState;
      if (video.status === "gap") state = { status: "error", durationSeconds: 0, error: video.reason ?? "此帧未被录制" };
      else {
        let pending = states.get(reference.asset);
        if (!pending) { pending = videoState(join(scope.index.archiveWorkspace, ".rsa/timeline"), reference.asset, scope.signal); states.set(reference.asset, pending); }
        state = await pending;
      }
      const originAt = time - video.pts * video.timeBase[0] / video.timeBase[1] * 1000;
      const readableBytes = state.format === "fmp4" ? state.readableBytes ?? 0 : 0;
      return { ...base, video: { assetId: reference.asset,
        revision: state.status === "pending" ? `pending:${readableBytes}` : state.status,
        url: url(scope, { mode: "segment", ...proof, ...(readableBytes > 0 ? { bytes: readableBytes } : {}) }),
        originAt,
        ...(typeof state.lastReadablePts === "number" ? { readableUntil: originAt + state.lastReadablePts / 1000 } : {}),
        width: video.width, height: video.height, durationSeconds: state.durationSeconds,
        status: video.status === "gap" ? "gap" as const : state.status,
        streaming: state.status === "pending" && readableFrame(state, video),
        ...(state.error ? { reason: state.error } : {}) } };
    })) };
}
interface Cursor { scope: [string, string, string | null, number, number, string]; generation: string;
  events: number; verifiedEnd: number; frames?: number; after: number | TimelineCursor }
function cursorFor(scope: Scope, query: ReplayQuery): Cursor {
  const start = query.start!, end = query.end!;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end - start > MAX_WINDOW)
    fail("时间窗须为 UTC 毫秒，跨度不超过 60 秒");
  const identity: Cursor["scope"] = [scope.project, scope.run, scope.epoch, start, end, query.mode];
  if (!query.cursor) return { scope: identity, generation: scope.index.generation, events: scope.index.eventRevision,
    verifiedEnd: scope.endAt, after: query.mode === "frames" ? [-1, -1] : 0 };
  try {
    if (query.cursor.length > 4096) throw new Error();
    const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    if (JSON.stringify(value.scope) !== JSON.stringify(identity) || value.generation !== scope.index.generation || !Number.isSafeInteger(value.events)
      || value.events < 0 || value.events > scope.index.eventRevision || !Number.isSafeInteger(value.verifiedEnd)
      || (value.frames !== undefined && (!Number.isSafeInteger(value.frames) || value.frames < 0))
      || (query.mode === "frames" ? !Array.isArray(value.after) || value.after.length !== 2 || !value.after.every(Number.isFinite)
        : !Number.isSafeInteger(value.after))) throw new Error();
    return value;
  } catch { return fail("回放分页游标已失效，请重新读取时间窗"); }
}
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function framesWindow(scope: Scope, query: ReplayQuery): Promise<ReplayWindow> {
  const cursor = cursorFor(scope, query), startAt = query.start!, endAt = query.end!;
  if (!scope.index.archiveWorkspace || startAt > scope.endAt || endAt < scope.startAt)
    return { startAt, endAt, frames: [], items: [], coverage: scope.coverage };
  const selected = await timelineWindow(join(scope.index.archiveWorkspace, ".rsa/timeline"), { run: scope.run,
    start: startAt, end: endAt, scopeStart: scope.startAt, scopeEnd: Math.min(scope.endAt, cursor.verifiedEnd), limit: PAGE,
    maxSequence: cursor.frames, ...(query.cursor ? { after: cursor.after as TimelineCursor } : {}), signal: scope.signal });
  const states = new Map<string, Promise<VideoState>>();
  return { startAt, endAt, frames: await Promise.all(selected.records.map(record => frame(record, scope, states))), items: [], coverage: scope.coverage,
    ...(selected.next ? { nextCursor: encodeCursor({ ...cursor, frames: selected.maxSequence, after: selected.next }) } : {}) };
}
const label = (event: Event, track: ReplayItem["track"]) => {
  const d = event.data;
  return String(track === "model" ? `${d.provider ?? "模型"}/${d.model ?? "调用"}` : track === "tool" ? `${d.toolName ?? "工具"}${d.intent ? ` · ${d.intent}` : ""}`
    : track === "action" ? d.controllerId ?? "play" : `${event.source?.component ?? "RSA"} · ${event.type}${typeof d.error === "string" ? ` · ${d.error}` : ""}`).slice(0, 240);
};
const outcome = (event: Event) => event.type === "model_error" || event.data.isError || event.data.error || event.data.outcome === "error" ? "error"
  : event.data.status === "interrupted" || event.data.aborted || event.data.stopReason === "aborted" ? "cancelled"
    : typeof event.data.status === "string" ? event.data.status : "completed";
function item(position: number, event: Event, operation?: OperationRef): ReplayItem {
  const trace = event.trace ?? {}, track = operation?.track ?? "log";
  return { id: `event:${position}`, track, startAt: operation ? Date.parse(operation.startAt) : at(event),
    endAt: operation ? operation.endAt ? Date.parse(operation.endAt) : null : at(event), label: label(event, track),
    status: operation ? operation.status ?? (operation.endAt ? "completed" : "pending") : outcome(event),
    source: { seq: event.seq, ...(event.origin ? { eventId: event.origin.eventId, sourceId: event.origin.clockId } : {}), ...(trace.modelCallId ? { modelCallId: trace.modelCallId } : {}),
      ...(trace.toolCallId ? { toolCallId: trace.toolCallId } : {}), ...(trace.traceId ? { traceId: trace.traceId } : {}),
      ...(typeof event.data.actionId === "string" ? { actionId: event.data.actionId } : {}) } };
}
async function eventsWindow(scope: Scope, query: ReplayQuery): Promise<ReplayWindow> {
  const cursor = cursorFor(scope, query), startAt = query.start!, endAt = query.end!, low = Math.max(startAt, scope.startAt), high = Math.min(endAt, scope.endAt, cursor.verifiedEnd);
  if (low > high) return { startAt, endAt, frames: [], items: [], coverage: scope.coverage };
  await prepareOperations(scope);
  const epoch = scope.epoch === null ? {} : { epoch: scope.epoch };
  const refs = await scope.index.queryEventRefs({ ...epoch, fromAt: low, toAt: high, afterPosition: cursor.after as number,
    beforePosition: cursor.events + 1, limit: PAGE + 1, signal: scope.signal });
  const operations = await queryOperationRefs(scope.index, { ...epoch, start: low, end: high, afterPosition: cursor.after as number,
    beforePosition: cursor.events + 1, limit: PAGE + 1, signal: scope.signal });
  const candidates = new Map<number, { ref?: EventRef; operation?: OperationRef }>(refs.map(ref => [ref.position, { ref }]));
  for (const operation of operations) if (operation.startPosition <= cursor.events)
    candidates.set(operation.startPosition, { ...candidates.get(operation.startPosition), operation });
  const positions = [...candidates.keys()].sort((a, b) => a - b), selected = positions.slice(0, PAGE), items: ReplayItem[] = [];
  for (const position of selected) {
    scope.signal?.throwIfAborted();
    const candidate = candidates.get(position)!, event = await scope.index.readEvent(candidate.ref ?? position);
    if (event) items.push(item(position, event, candidate.operation));
  }
  return { startAt, endAt, frames: [], items, coverage: scope.coverage,
    ...(positions.length > PAGE ? { nextCursor: encodeCursor({ ...cursor, after: selected.at(-1)! }) } : {}) };
}
async function prepareOperations(scope: Scope) {
  if (scope.index.frozen) {
    if (scope.index.meta("cold:ready") === "1") return;
    throw Object.assign(new Error("正在整理动作与调用目录"), {
      status: 202, code: "ARCHIVE_PREPARING", progress: archiveBuildState(scope.index),
    });
  }
  const progress = await refreshOperationIndex(scope.index, { maxEvents: 5000, signal: scope.signal });
  if (!progress.complete) throw Object.assign(new Error("正在整理动作与调用目录"), {
    status: 202, code: "ARCHIVE_PREPARING", progress: { kind: "operations", ...progress, total: scope.index.eventRevision },
  });
}
async function storedRecord(scope: Scope, id: string | undefined, sequence: number | undefined) {
  if (!id || !Number.isSafeInteger(sequence) || sequence! < 1) fail("无效的时空轴记录引用");
  if (!scope.index.archiveWorkspace) fail("工作区没有有效注册", 404);
  const root = join(scope.index.archiveWorkspace, ".rsa/timeline"), record = await timelineRecord(root, id, sequence!, scope.signal);
  if (!record || record.id !== id || record.runId !== scope.run) fail("记录不属于所选运行或周期", 404);
  const time = Date.parse(record.recordedAt);
  if (time < scope.startAt || time > scope.endAt) {
    if (!scope.coverage?.complete && time > (scope.coverage?.throughAt ?? scope.endAt)) fail("此时刻的周期边界尚在读取，请稍后重试", 409);
    fail("记录不属于所选运行或周期", 404);
  }
  return { root, record };
}
async function expandEvent(event: Event, index: LogIndex) {
  const data = { ...event.data };
  for (const name of ["argsRef", "result", "payload", "response"])
    if (data[name]?.encoding) data[name] = await readArtifact(index.path, data[name], { media: "reference", workspace: index.archiveWorkspace });
  return { ...event, data };
}
async function itemDetail(scope: Scope, id: string | undefined): Promise<ReplayDetail> {
  if (!id || !/^event:\d+$/.test(id)) fail("无效的回放事件引用");
  await prepareOperations(scope);
  const index = scope.index, position = Number(id.slice(6)), start = await index.readEvent(position);
  if (!start || !scoped(start, scope.epoch)) fail("事件不属于所选运行或周期", 404);
  const operation = await getOperation(index, position), projected = item(position, start, operation), events = [start];
  if (operation?.endPosition) { const end = await index.readEvent(operation.endPosition); if (end) events.push(end); }
  const epoch = start.trace?.epoch ?? null;
  if (projected.track === "action" && start.trace?.traceId && start.trace.spanId) {
    const commands = await index.queryEvents({ epoch, traceId: start.trace.traceId, spanId: start.trace.spanId, types: ["command"], limit: 10, signal: scope.signal });
    events.push(...commands.map(row => row.event));
  }
  let observations: ReplayDetail["observations"];
  if (projected.track === "model" && start.trace?.modelCallId) {
    const requests = await index.queryEvents({ epoch, model: start.trace.modelCallId, types: ["model_request"], limit: 100, signal: scope.signal });
    events.push(...requests.map(row => row.event)); observations = [];
    const { inputs, contexts } = await modelInputEvents(index, start, position, scope.signal);
    const call = aggregate([...inputs, ...contexts, start]).calls[0];
    const delivered = Array.isArray(start.data.deliveryIds) ? call?.inputObservations ?? [] : undefined;
    const failedQueries = new Set(call?.perceptionReads?.filter(read => read.deliveryError).map(read => read.queryId));
    events.push(...inputs.filter(input => input.type === "perception_input_error"));
    const inputObservations = new Map(inputs.filter(input => !failedQueries.has(input.data.queryId))
      .flatMap(input => eventObservations(input).map(observation => [observation.id, observation] as const)));
    for (const observationId of new Set<string>(delivered ?? [...(start.data.observations ?? []), ...inputObservations.keys()])) {
      let observation = inputObservations.get(observationId);
      if (!observation) {
        const originals = await index.queryEvents({ epoch, observationId, beforePosition: position, reverse: true,
          types: ["observation", "perception_observe_end", "observe_hook_end"], limit: 10, signal: scope.signal });
        for (const original of originals) { observation = eventObservations(original.event).find(value => value.id === observationId); if (observation) break; }
      }
      const record = observation?.timeline;
      const [encoded] = await index.queryEvents({ epoch, observationId, beforePosition: position, reverse: true,
        types: ["observation_media"], limit: 1, signal: scope.signal });
      observations.push({ id: observationId, ...(encoded ? { url: url(scope, { mode: "media", id: `model-media:${encoded.position}` }) } : {}),
        ...(encoded?.event.data.modelMedia?.video || record?.video ? { approximate: true } : {}),
        ...(record?.recordId ? { recordId: record.recordId, sequence: record.sequence } : {}) });
    }
    for (const perception of call?.perceptionReads ?? []) {
      if (perception.deliveryError) continue;
      for (const snapshot of [perception?.snapshot, ...(perception?.records?.map(record => record.snapshot) ?? [])])
        if (snapshot?.timeline && !observations.some(value => value.recordId === snapshot.timeline!.recordId))
          observations.push({ id: snapshot.id, recordId: snapshot.timeline.recordId, sequence: snapshot.timeline.sequence });
    }
  }
  return { title: projected.label, data: { item: projected, events: await Promise.all(events.map(event => expandEvent(event, index))) }, ...(observations ? { observations } : {}) };
}
async function assetMedia(root: string, asset: string, mediaType: string, video?: VideoFrameReference, signal?: AbortSignal): Promise<FileMedia | { bytes: Buffer; mediaType: string }> {
  if (video) return { bytes: await decodeTimelineFrame(root, { asset, video }, { signal }), mediaType: "image/png" };
  const file = await timelinePath(root, asset).catch(error => { if (error.code === "ENOENT") expired(); throw error; });
  if (["video/mp4", "video/webm"].includes(mediaType)) return { file, mediaType };
  const bytes = await readFile(file, { signal }).catch(error => { if (error.code === "ENOENT") expired(); throw error; });
  return { bytes, mediaType: ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/wav", "audio/mpeg"].includes(mediaType) ? mediaType : "text/plain; charset=utf-8" };
}
async function recordMedia(root: string, record: StoredTimelineRecord, media: number | undefined, signal?: AbortSignal) {
  if (!Number.isSafeInteger(media) || media! < 0) fail("无效的媒体序号");
  const selected = record.media?.[media!];
  if (!selected?.timeline?.asset) expired();
  if (selected.timeline.recordId !== record.id || selected.timeline.sequence !== record.sequence) fail("媒体与记录引用不匹配");
  return assetMedia(root, selected.timeline.asset, selected.mediaType, selected.timeline.video, signal);
}
async function modelMedia(scope: Scope, id: string) {
  if (!/^model-media:\d+$/.test(id)) fail("无效的模型媒体引用");
  const event = await scope.index.readEvent(Number(id.slice("model-media:".length)));
  if (!event || event.type !== "observation_media" || !scope.index.archiveWorkspace || !scoped(event, scope.epoch)) fail("媒体不属于所选运行或周期", 404);
  const media = event.data.modelMedia;
  if (!media?.asset || !media?.mediaType) expired();
  return assetMedia(join(scope.index.archiveWorkspace, ".rsa/timeline"), media.asset, media.mediaType, media.video, scope.signal);
}
async function segmentMedia(scope: Scope, query: ReplayQuery): Promise<FileMedia> {
  if (query.asset !== undefined && !/^video\/[a-zA-Z0-9_-]+\.mp4$/.test(query.asset)) fail("无效的视频片段引用");
  if (query.bytes !== undefined && (!Number.isSafeInteger(query.bytes) || query.bytes <= 0)) fail("无效的视频片段字节快照");
  const { root, record } = await storedRecord(scope, query.record, query.sequence);
  if (!Number.isSafeInteger(query.media) || query.media! < 0) fail("无效的媒体序号");
  const reference = record.media?.[query.media!]?.timeline, asset = reference?.asset;
  if (!asset || !/^video\/[a-zA-Z0-9_-]+\.mp4$/.test(asset) || !reference.video) fail("无效的视频片段引用");
  if (query.asset !== undefined && query.asset !== asset) fail("视频片段不属于所选记录", 404);
  if (reference.recordId !== record.id || reference.sequence !== record.sequence) fail("媒体与记录引用不匹配");
  if (reference.video.status === "gap") fail(reference.video.reason ?? "此帧未被录制", 410);
  const state = await videoState(root, asset, scope.signal);
  if (state.status === "error") fail(state.error ?? "视频片段未完成", 410);
  if (state.status === "pending" && !readableFrame(state, reference.video)) fail("视频片段正在写入，请稍后刷新", 409);
  if (state.format === "fmp4" && !readableFrame(state, reference.video)) fail("此帧没有已完成的视频片段", 410);
  if (query.bytes !== undefined && (state.format !== "fmp4" || query.bytes > (state.readableBytes ?? 0))) fail("视频片段字节快照超出已发布范围");
  const size = state.format === "fmp4" ? query.bytes ?? state.readableBytes : undefined;
  return { file: await timelinePath(root, asset), mediaType: "video/mp4", ...(size !== undefined ? { size } : {}),
    cacheControl: state.status === "pending" && query.bytes === undefined ? "no-store" : "private, max-age=31536000, immutable" };
}

/** Read archived facts only. Video and frame requests never wait for event presentation work. */
export async function getReplay(project: string, run: string, query: ReplayQuery, root = globalHome, signal?: AbortSignal) {
  const { index, release } = await openRun(project, run, root);
  try {
    signal?.throwIfAborted();
    const result = await scopeFor(index, project, run, query.epoch, query.mode === "overview" || query.mode === "events" || query.mode === "detail", signal);
    if (query.mode === "overview") {
      if (result.startAt === null) return result satisfies ReplayOverviewResult;
      const { index: _, signal: __, ...overview } = result; return overview;
    }
    const scope = ready(result);
    if (query.mode === "frames") return await framesWindow(scope, query);
    if (query.mode === "events") return await eventsWindow(scope, query);
    if (query.mode === "segment") return await segmentMedia(scope, query);
    if (query.mode === "media" && query.id) return await modelMedia(scope, query.id);
    if (query.mode === "detail" && !query.record) return await itemDetail(scope, query.id);
    if (query.mode === "detail" || query.mode === "media") {
      const { root: timelineRoot, record } = await storedRecord(scope, query.record, query.sequence);
      return query.mode === "media" ? await recordMedia(timelineRoot, record, query.media, signal) : { title: record.capability, data: record } satisfies ReplayDetail;
    }
    return fail("无效的回放查询模式");
  } finally { release(); }
}
