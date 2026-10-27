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
export async function readTimelineRecord(root: string, recordId: string, sequence: number): Promise<TimelineRecordDetail | undefined> {
  const segments = await timelinePath(root, "segments");
  for (const name of await readdir(segments)) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = JSON.parse(await readFile(await timelinePath(root, `segments/${name}`), "utf8"));
    if (![meta.firstSequence, meta.lastSequence].every(Number.isSafeInteger)
      || meta.firstSequence < 1 || meta.lastSequence < meta.firstSequence || sequence < meta.firstSequence || sequence > meta.lastSequence) continue;
    const stem = name.slice(0, -".meta.json".length);
    const index = await open(await timelinePath(root, `segments/${stem}.idx`), "r");
    const entry = Buffer.alloc(64);
    try {
      const { bytesRead } = await index.read(entry, 0, entry.length, (sequence - meta.firstSequence) * 64);
      if (bytesRead !== entry.length || entry.readBigUInt64BE(8) !== BigInt(sequence)
        || !entry.subarray(48, 64).equals(createHash("sha256").update(recordId).digest().subarray(0, 16))) continue;
    } finally { await index.close(); }
    const offset = Number(entry.readBigUInt64BE(16)), length = Number(entry.readBigUInt64BE(24));
    const payload = await open(await timelinePath(root, `segments/${stem}.jsonl`), "r");
    try {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(offset + length) || length < 1
        || offset + length > (await payload.stat()).size) throw new Error("时空轴记录索引不完整");
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await payload.read(bytes, read, length - read, offset + read);
        if (!bytesRead) throw new Error("时空轴记录读取不完整");
        read += bytesRead;
      }
      const record = JSON.parse(bytes.toString("utf8"));
      if (record.id !== recordId || record.sequence !== sequence) throw new Error("时空轴记录引用不匹配");
      return { recordId, sequence, ...(record.data === undefined ? {} : { data: record.data }),
        ...(record.space === undefined ? {} : { space: record.space }) };
    } finally { await payload.close(); }
  }
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

/** The committed binary index is authoritative; tail writes become visible with its metadata. */
export async function* timelinePointers(root: string, afterSequence = 0): AsyncGenerator<TimelinePointer> {
  let names: string[];
  try { names = await readdir(await timelinePath(root, "segments")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const segments: { stem: string; firstSequence: number; lastSequence: number; count: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = JSON.parse(await readFile(await timelinePath(root, `segments/${name}`), "utf8"));
    if (![meta.firstSequence, meta.lastSequence, meta.count].every(Number.isSafeInteger)
      || meta.firstSequence < 1 || meta.count < 0 || meta.lastSequence - meta.firstSequence + 1 !== meta.count)
      throw new Error("时空轴分段索引无效");
    if (meta.lastSequence > afterSequence) segments.push({ stem: name.slice(0, -10), ...meta });
  }
  segments.sort((a, b) => a.firstSequence - b.firstSequence);
  for (const segment of segments) {
    const file = await timelinePath(root, `segments/${segment.stem}.jsonl`);
    const handle = await open(await timelinePath(root, `segments/${segment.stem}.idx`), "r");
    try {
      const chunk = Buffer.alloc(64 * 512);
      for (let entry = Math.max(0, afterSequence + 1 - segment.firstSequence); entry < segment.count;) {
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
          yield { sequence, at, file, offset: payloadOffset, length: payloadLength,
            capabilityHash: chunk.subarray(i + 32, i + 48).toString("hex"), recordHash: chunk.subarray(i + 48, i + 64).toString("hex") };
        }
      }
    } finally { await handle.close(); }
  }
}

export async function readTimelinePayload(pointer: TimelinePointer): Promise<StoredTimelineRecord> {
  const handle = await open(pointer.file, "r");
  try {
    if (!Number.isSafeInteger(pointer.offset + pointer.length) || pointer.offset + pointer.length > (await handle.stat()).size)
      throw new Error("时空轴记录索引不完整");
    const bytes = Buffer.alloc(pointer.length);
    let offset = 0;
    while (offset < bytes.length) {
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
