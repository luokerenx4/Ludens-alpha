import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { VideoFrameReference } from "../../shared/timeline-media";

export interface TimelineRecordDetail {
  recordId: string;
  sequence: number;
  data?: unknown;
  space?: unknown;
}

export async function timelinePath(root: string, asset = "") {
  if (asset && !asset.split("/").every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== ".."))
    throw new Error("无效的时空轴路径");
  const path = join(root, asset);
  if (await realpath(root) !== root || await realpath(path) !== path)
    throw new Error("观测文件必须位于当前工作区时空轴内");
  return path;
}

/** One 64-byte index entry and one payload, never an entire timeline or segment. */
export async function readTimelineRecord(root: string, recordId: string, sequence: number, signal?: AbortSignal): Promise<TimelineRecordDetail | undefined> {
  const record = await timelineRecord(root, recordId, sequence, signal);
  return record ? { recordId, sequence, ...(record.data === undefined ? {} : { data: record.data }),
    ...(record.space === undefined ? {} : { space: record.space }) } : undefined;
}

export interface TimelinePointer {
  recordId?: string;
  sequence: number;
  at: number;
  file: string;
  offset: number;
  length: number;
  capabilityHash: string;
  recordHash: string;
}

export interface StoredTimelineRecord {
  id: string;
  sequence: number;
  recordedAt: string;
  capability: string;
  runId?: string;
  text?: string;
  media?: { mediaType: string; timeline?: { asset: string; recordId?: string; sequence?: number; video?: VideoFrameReference } }[];
  [key: string]: unknown;
}

export interface TimelineSegment {
  stem: string;
  firstSequence: number;
  lastSequence: number;
  count: number;
  minimum?: { recordedAt: string; sequence: number };
  maximum?: { recordedAt: string; sequence: number };
}

/** Only the small committed segment summaries are read here; frame payloads stay on disk. */
export async function timelineSegments(root: string, signal?: AbortSignal): Promise<TimelineSegment[]> {
  let names: string[];
  try { names = await readdir(await timelinePath(root, "segments")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const segments: TimelineSegment[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    if (!name.endsWith(".meta.json")) continue;
    const meta = JSON.parse(await readFile(await timelinePath(root, `segments/${name}`), { encoding: "utf8", signal }));
    if (![meta.firstSequence, meta.lastSequence, meta.count].every(Number.isSafeInteger)
      || meta.firstSequence < 1 || meta.count < 0 || meta.lastSequence - meta.firstSequence + 1 !== meta.count)
      throw new Error("时空轴分段索引无效");
    segments.push({ stem: name.slice(0, -10), firstSequence: meta.firstSequence, lastSequence: meta.lastSequence,
      count: meta.count, minimum: meta.minimum, maximum: meta.maximum });
  }
  return segments.sort((a, b) => a.firstSequence - b.firstSequence);
}

export async function timelineRecord(root: string, id: string, sequence: number, signal?: AbortSignal) {
  const segment = (await timelineSegments(root, signal)).find(value => value.firstSequence <= sequence && sequence <= value.lastSequence);
  if (!segment) return undefined;
  signal?.throwIfAborted();
  const handle = await open(await timelinePath(root, `segments/${segment.stem}.idx`), "r");
  const entry = Buffer.alloc(64);
  try {
    const { bytesRead } = await handle.read(entry, 0, 64, (sequence - segment.firstSequence) * 64);
    if (bytesRead !== 64 || Number(entry.readBigUInt64BE(8)) !== sequence
      || !entry.subarray(48, 64).equals(createHash("sha256").update(id).digest().subarray(0, 16))) return undefined;
  } finally { await handle.close(); }
  return readTimelinePayload({ sequence, at: Math.round(entry.readDoubleBE(0) * 1000),
    file: await timelinePath(root, `segments/${segment.stem}.jsonl`), offset: Number(entry.readBigUInt64BE(16)),
    length: Number(entry.readBigUInt64BE(24)), capabilityHash: entry.subarray(32, 48).toString("hex"),
    recordHash: entry.subarray(48, 64).toString("hex") }, signal);
}

export interface TimelineSelection {
  afterSequence?: number;
  maxSequence?: number;
  start?: number;
  end?: number;
  signal?: AbortSignal;
  segments?: TimelineSegment[];
}

/** The committed binary index is authoritative; tail writes become visible with its metadata. */
export async function* timelinePointers(root: string, afterSequence = 0, selection: TimelineSelection = {}): AsyncGenerator<TimelinePointer> {
  const segments = selection.segments ?? await timelineSegments(root, selection.signal);
  for (const segment of segments) {
    selection.signal?.throwIfAborted();
    if (segment.lastSequence <= afterSequence || segment.firstSequence > (selection.maxSequence ?? Infinity)) continue;
    if (segment.minimum && Date.parse(segment.minimum.recordedAt) > (selection.end ?? Infinity)) continue;
    if (segment.maximum && Date.parse(segment.maximum.recordedAt) < (selection.start ?? -Infinity)) continue;
    const file = await timelinePath(root, `segments/${segment.stem}.jsonl`);
    const handle = await open(await timelinePath(root, `segments/${segment.stem}.idx`), "r");
    try {
      const chunk = Buffer.alloc(64 * 512);
      for (let entry = Math.max(0, afterSequence + 1 - segment.firstSequence); entry < segment.count;) {
        selection.signal?.throwIfAborted();
        const length = Math.min(chunk.length, (segment.count - entry) * 64);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(chunk, offset, length - offset, entry * 64 + offset);
          if (!bytesRead) throw new Error("时空轴分段索引不完整");
          offset += bytesRead;
        }
        for (let i = 0; i < length; i += 64, entry++) {
          const sequence = Number(chunk.readBigUInt64BE(i + 8));
          const at = Math.round(chunk.readDoubleBE(i) * 1000);
          const payloadOffset = Number(chunk.readBigUInt64BE(i + 16)), payloadLength = Number(chunk.readBigUInt64BE(i + 24));
          if (sequence !== segment.firstSequence + entry || !Number.isFinite(at)
            || !Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLength) || payloadOffset < 0 || payloadLength < 1)
            throw new Error("时空轴记录索引无效");
          if (sequence > (selection.maxSequence ?? Infinity)) return;
          if (at < (selection.start ?? -Infinity) || at > (selection.end ?? Infinity)) continue;
          yield { sequence, at, file, offset: payloadOffset, length: payloadLength,
            capabilityHash: chunk.subarray(i + 32, i + 48).toString("hex"), recordHash: chunk.subarray(i + 48, i + 64).toString("hex") };
        }
      }
    } finally { await handle.close(); }
  }
}

export async function readTimelinePayload(pointer: TimelinePointer, signal?: AbortSignal): Promise<StoredTimelineRecord> {
  signal?.throwIfAborted();
  const handle = await open(pointer.file, "r");
  try {
    if (!Number.isSafeInteger(pointer.offset + pointer.length) || pointer.offset + pointer.length > (await handle.stat()).size)
      throw new Error("时空轴记录索引不完整");
    const bytes = Buffer.alloc(pointer.length);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, pointer.offset + offset);
      if (!bytesRead) throw new Error("时空轴记录读取不完整");
      offset += bytesRead;
    }
    const record = JSON.parse(bytes.toString("utf8")) as StoredTimelineRecord;
    const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
    if (record.sequence !== pointer.sequence || typeof record.id !== "string" || typeof record.capability !== "string"
      || shortHash(record.id) !== pointer.recordHash || shortHash(record.capability) !== pointer.capabilityHash
      || Math.abs(Date.parse(record.recordedAt) - pointer.at) > 0.01)
      throw new Error("时空轴记录引用不匹配");
    return record;
  } finally { await handle.close(); }
}

export type TimelineCursor = [at: number, sequence: number];
const comparePoint = (a: TimelineCursor, b: TimelineCursor) => a[0] - b[0] || a[1] - b[1];
const point = (value: TimelinePointer): TimelineCursor => [value.at, value.sequence];

/** Select one bounded page from the existing binary indexes; never build a frame projection. */
export async function timelineWindow(root: string, options: {
  run: string; start: number; end: number; scopeStart: number; scopeEnd: number;
  after?: TimelineCursor; maxSequence?: number; limit: number; signal?: AbortSignal;
}) {
  const segments = await timelineSegments(root, options.signal);
  const maxSequence = Math.min(options.maxSequence ?? Infinity, segments.at(-1)?.lastSequence ?? 0);
  const low = Math.max(options.start, options.scopeStart), high = Math.min(options.end, options.scopeEnd);
  const candidates: TimelinePointer[] = [];
  const previous = new Map<string, StoredTimelineRecord>();
  const excluded = new Set<number>();
  // Channels may be sparse, or interleaved with a different run. Check each candidate's
  // original run identity, then continue backwards only for channels whose candidate was rejected.
  if ((!options.after || options.after[0] < low) && low > options.scopeStart) {
    for (;;) {
      const latest = new Map<string, TimelinePointer>();
      for await (const entry of timelinePointers(root, 0, { segments, maxSequence, start: options.scopeStart,
        end: low - 1, signal: options.signal })) {
        if (previous.has(entry.capabilityHash) || excluded.has(entry.sequence)) continue;
        const old = latest.get(entry.capabilityHash);
        if (!old || comparePoint(point(entry), point(old)) > 0) latest.set(entry.capabilityHash, entry);
      }
      if (!latest.size) break;
      let rejected = false;
      for (const [hash, entry] of latest) {
        const record = await readTimelinePayload(entry, options.signal);
        if (record.runId === options.run) previous.set(hash, record);
        else { excluded.add(entry.sequence); rejected = true; }
      }
      if (!rejected) break;
    }
  }
  for await (const entry of timelinePointers(root, 0, { segments, maxSequence, start: low, end: high, signal: options.signal })) {
    if (options.after && comparePoint(point(entry), options.after) <= 0) continue;
    let lo = 0, hi = candidates.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (comparePoint(point(candidates[mid]), point(entry)) < 0) lo = mid + 1; else hi = mid; }
    candidates.splice(lo, 0, entry);
    if (candidates.length > options.limit + 1) candidates.pop();
  }
  const selected = candidates.slice(0, options.limit), records = [...previous.values()].filter(record =>
    !options.after || comparePoint([Date.parse(record.recordedAt), record.sequence], options.after) > 0);
  for (const entry of selected) {
    const record = await readTimelinePayload(entry, options.signal);
    if (record.runId === options.run) records.push(record);
  }
  records.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.sequence - b.sequence);
  const page = records.slice(0, options.limit);
  const next = records.length > options.limit
    ? [Date.parse(page.at(-1)!.recordedAt), page.at(-1)!.sequence] as TimelineCursor
    : candidates.length > options.limit ? point(selected.at(-1)!) : undefined;
  return { records: page, maxSequence, ...(next ? { next } : {}) };
}
