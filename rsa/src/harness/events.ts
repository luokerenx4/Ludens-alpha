import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Clock } from "../contracts.ts";

export interface EventTrace {
  epoch?: string;
  modelCallId?: string;
  requestId?: string;
  httpId?: string;
  toolCallId?: string;
  operationId?: string;
}
export type RecordEvent = (type: string, data: unknown, trace?: EventTrace) => void;
export interface ArtifactRef { path: string; sha256: string; bytes: number; encoding: "gzip" }

/** One append-only timeline per run; large payloads are immutable sidecar files. */
export class EventLog {
  private sequence = 0;
  constructor(readonly directory: string, readonly clock: Clock) {
    mkdirSync(join(directory, "payloads"), { recursive: true });
    mkdirSync(join(directory, "streams"), { recursive: true });
  }

  readonly record: RecordEvent = (type, data, trace = {}) => {
    appendFileSync(join(this.directory, "events.jsonl"), JSON.stringify({
      schemaVersion: 1, runId: this.clock.id, seq: ++this.sequence,
      at: new Date().toISOString(), atMs: this.clock.now(), type, trace, data,
    }) + "\n");
  };

  artifact(value: unknown): ArtifactRef { return this.bytes(Buffer.from(JSON.stringify(value)), "json"); }

  bytes(bytes: Uint8Array, format = "bin"): ArtifactRef {
    const sha256 = new Bun.SHA256().update(bytes).digest("hex");
    const path = `payloads/${sha256}.${format}.gz`;
    if (!existsSync(join(this.directory, path))) writeFileSync(join(this.directory, path), gzipSync(bytes));
    return { path, sha256, bytes: bytes.byteLength, encoding: "gzip" };
  }

  stream(path: string, event: unknown, trace: EventTrace) {
    appendFileSync(join(this.directory, path), JSON.stringify({ atMs: this.clock.now(), trace, event }) + "\n");
  }
}
