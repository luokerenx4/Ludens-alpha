import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { Clock } from "@playness/baseware/contracts";
import type { EventMetadata, EventSource } from "@playness/baseware/protocol";

export type { EventMetadata, EventSource } from "@playness/baseware/protocol";
export const EVENT_SCHEMA_VERSION = 2;
export const RSA_SOURCE: EventSource = { component: "rsa" };

export interface EventTrace {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  epoch?: string;
  modelCallId?: string;
  requestId?: string;
  httpId?: string;
  toolCallId?: string;
  operationId?: string;
}
export type RecordEvent = (type: string, data: unknown, trace?: EventTrace, metadata?: EventMetadata) => void;
export interface ArtifactRef { path: string; sha256: string; bytes: number; encoding: "gzip" }

/** Cross-process children keep the native Shiori trace without requiring a global tracer. */
export function childTrace(parent: EventTrace = {}): EventTrace {
  return { ...parent, traceId: parent.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"), parentSpanId: parent.spanId };
}

/** One append-only timeline per run; large payloads are immutable sidecar files. */
export class EventLog {
  private sequence = 0;
  constructor(readonly directory: string, readonly clock: Clock) {
    mkdirSync(join(directory, "payloads"), { recursive: true });
    mkdirSync(join(directory, "streams"), { recursive: true });
  }

  readonly record: RecordEvent = (type, data, trace = {}, metadata = {}) => {
    const seq = ++this.sequence;
    const at = new Date().toISOString(), atMs = this.clock.now();
    appendFileSync(join(this.directory, "events.jsonl"), JSON.stringify({
      schemaVersion: EVENT_SCHEMA_VERSION, runId: this.clock.id, seq, at, atMs,
      source: metadata.source ?? RSA_SOURCE,
      origin: metadata.origin ?? { eventId: `${this.clock.id}:${seq}`, clockId: this.clock.id, seq, at, atMs },
      type, trace, data,
    }) + "\n");
  };

  recorder(source: EventSource): RecordEvent {
    return (type, data, trace, metadata) => this.record(type, data, trace, { source, ...metadata });
  }

  artifact(value: unknown): ArtifactRef { return this.bytes(Buffer.from(JSON.stringify(value)), "json"); }

  bytes(bytes: Uint8Array, format = "bin"): ArtifactRef {
    const sha256 = new Bun.SHA256().update(bytes).digest("hex");
    const path = `payloads/${sha256}.${format}.gz`;
    if (!existsSync(join(this.directory, path))) writeFileSync(join(this.directory, path), gzipSync(bytes));
    return { path, sha256, bytes: bytes.byteLength, encoding: "gzip" };
  }

  stream(path: string, event: unknown, trace: EventTrace, source: EventSource = RSA_SOURCE) {
    appendFileSync(join(this.directory, path), JSON.stringify({ at: new Date().toISOString(), atMs: this.clock.now(), source, trace, event }) + "\n");
  }
}
