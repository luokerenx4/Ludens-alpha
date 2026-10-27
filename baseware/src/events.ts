import { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventMetadata, RecordEvent } from "./protocol.ts";
import type { EventChannel, EventSegment, EventSourceDescriptor } from "../../shared/event-sources.ts";

/** Device facts belong to this service, including calls from clients other than RSA. */
export class EventLog {
  readonly source: EventSourceDescriptor;
  private active = new Map<EventChannel, { path: string; bucket: number; meta: EventSegment }>();
  constructor(directory: string, serviceId: string, private options: { segmentSeconds?: number; segmentBytes?: number } = {}) {
    const root = resolve(directory, serviceId);
    for (const channel of ["events", "diagnostics"]) mkdirSync(join(root, channel), { recursive: true });
    this.source = { sourceId: serviceId, root: realpathSync(root), format: "baseware-events-v1" };
    writeFileSync(join(this.source.root, "source.json"), JSON.stringify(this.source));
  }
  readonly record: RecordEvent = (type, data, trace = {}, metadata) => {
    // The core assigns an identity once, before persistence and broadcasting.
    const { source, origin, channel } = metadata as Required<EventMetadata>;
    if (origin.clockId !== this.source.sourceId) throw new Error("Event source identity mismatch");
    const line = JSON.stringify({
      schemaVersion: 2, serviceId: origin.clockId, seq: origin.seq,
      at: origin.at, atMs: origin.atMs, source, origin, type, trace, data,
      ...(channel ? { channel } : {}),
    }) + "\n";
    const target: EventChannel = channel === "diagnostic" ? "diagnostics" : "events";
    const bytes = Buffer.byteLength(line), bucket = Math.floor(Date.parse(origin.at) / ((this.options.segmentSeconds ?? 3600) * 1000));
    let segment = this.active.get(target);
    if (!segment || segment.bucket !== bucket || segment.meta.bytes + bytes > (this.options.segmentBytes ?? 256 * 1024 * 1024)) {
      const stem = `${origin.at.replace(/[:.]/g, "-")}-${String(origin.seq).padStart(12, "0")}`;
      segment = { path: join(this.source.root, target, stem + ".jsonl"), bucket,
        meta: { sourceId: origin.clockId, channel: target, firstSeq: origin.seq, lastSeq: origin.seq,
          count: 0, bytes: 0, recordings: Object.create(null) } };
      this.active.set(target, segment);
    }
    try {
      appendFileSync(segment.path, line);
      const meta = segment.meta;
      meta.lastSeq = origin.seq; meta.count++; meta.bytes += bytes;
      if (typeof trace.recordingId === "string") {
        const range = meta.recordings[trace.recordingId] ??= { firstSeq: origin.seq, lastSeq: origin.seq };
        range.lastSeq = origin.seq;
      } else { meta.unowned ??= { firstSeq: origin.seq, lastSeq: origin.seq }; meta.unowned.lastSeq = origin.seq; }
      const path = segment.path.slice(0, -6) + ".meta.json";
      writeFileSync(path + ".tmp", JSON.stringify(meta));
      renameSync(path + ".tmp", path);
    } catch (error) {
      // A failed append may have left half a line. Resume in a fresh segment, never append to that tail.
      this.active.delete(target);
      throw error;
    }
  };
}
