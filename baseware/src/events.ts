import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./contracts.ts";
import type { RecordEvent } from "./protocol.ts";

/** Device facts belong to this service, including calls from clients other than RSA. */
export class EventLog {
  private sequence = 0;
  constructor(readonly directory: string, readonly clock: Clock) { mkdirSync(directory, { recursive: true }); }
  readonly record: RecordEvent = (type, data, trace = {}) => {
    appendFileSync(join(this.directory, "events.jsonl"), JSON.stringify({
      schemaVersion: 1, serviceId: this.clock.id, seq: ++this.sequence,
      at: new Date().toISOString(), atMs: this.clock.now(), type, trace, data,
    }) + "\n");
  };
}
