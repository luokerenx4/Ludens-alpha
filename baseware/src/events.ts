import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventMetadata, RecordEvent } from "./protocol.ts";

/** Device facts belong to this service, including calls from clients other than RSA. */
export class EventLog {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  readonly record: RecordEvent = (type, data, trace = {}, metadata) => {
    // The core assigns an identity once, before persistence and broadcasting.
    const { source, origin } = metadata as Required<EventMetadata>;
    appendFileSync(join(this.directory, "events.jsonl"), JSON.stringify({
      schemaVersion: 2, serviceId: origin.clockId, seq: origin.seq,
      at: origin.at, atMs: origin.atMs, source, origin, type, trace, data,
    }) + "\n");
  };
}
