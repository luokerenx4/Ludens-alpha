import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

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
