import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { JsonArchive, type JsonArchiveRef } from "../../../shared/log-archive.ts";
import type { Clock } from "@playness/baseware/contracts";
import type { EventMetadata, EventSource } from "@playness/baseware/protocol";

export type { EventMetadata, EventSource } from "@playness/baseware/protocol";
export const EVENT_SCHEMA_VERSION = 2;
export const RSA_SOURCE: EventSource = { component: "rsa" };

export interface EventTrace {
  recordingId?: string;
  recordingPurpose?: "continuous-perception" | "continuous-action";
  inputGeneration?: string;
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
export type DiagnosticsMode = "normal" | "full";
export type RegisterMedia = (media: Pick<Parameters<JsonArchive["registerMedia"]>[0], "sha256" | "asset" | "video">) => void;
export type ArtifactRef = JsonArchiveRef | { path: string; sha256: string; bytes: number; encoding: "gzip" };
interface WireMetadata {
  sha256: string; bytes: number; contentType?: string; contentEncoding?: string;
  representation: "json" | "text" | "unavailable";
}
type WireRef = ArtifactRef & { wire?: WireMetadata };

/** Cross-process children keep the native Shiori trace without requiring a global tracer. */
export function childTrace(parent: EventTrace = {}): EventTrace {
  return { ...parent, traceId: parent.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"), parentSpanId: parent.spanId };
}

/** One append-only timeline per run; large payloads are immutable sidecar files. */
export class EventLog {
  private sequence = 0;
  readonly archive?: JsonArchive;
  constructor(readonly directory: string, readonly clock: Clock, workspace?: string, readonly diagnostics: DiagnosticsMode = "normal") {
    if (workspace) this.archive = new JsonArchive(workspace);
    else mkdirSync(join(directory, "payloads"), { recursive: true });
    mkdirSync(join(directory, "streams"), { recursive: true });
  }

  readonly record: RecordEvent = (type, data, trace = {}, metadata = {}) => {
    if (metadata.channel === "diagnostic" && this.diagnostics !== "full") return;
    const seq = ++this.sequence;
    const at = new Date().toISOString(), atMs = this.clock.now();
    appendFileSync(join(this.directory, metadata.channel === "diagnostic" ? "diagnostics.jsonl" : "events.jsonl"), JSON.stringify({
      schemaVersion: EVENT_SCHEMA_VERSION, runId: this.clock.id, seq, at, atMs,
      source: metadata.source ?? RSA_SOURCE,
      origin: metadata.origin ?? { eventId: `${this.clock.id}:${seq}`, clockId: this.clock.id, seq, at, atMs },
      ...(metadata.channel ? { channel: metadata.channel } : {}), type, trace, data,
    }) + "\n");
  };

  // Registration is a bounded byte-identity cache, independent of event persistence.
  // JsonArchive persists a lookup only when a model/tool payload consumes it.
  readonly registerMedia: RegisterMedia = media => {
    try { this.archive?.registerMedia({ ...media }); }
    catch (error) { this.record("media_reference_error", { sha256: media.sha256, error: String(error) }); }
  };

  recorder(source: EventSource): RecordEvent {
    return (type, data, trace, metadata) => this.record(type, data, trace, { source, ...metadata });
  }

  artifact(value: unknown): ArtifactRef {
    return this.archive ? this.archive.write(value) : this.bytes(Buffer.from(JSON.stringify(value)), "json");
  }

  bytes(bytes: Uint8Array, format = "bin", headers: { contentType?: string | null; contentEncoding?: string | null } = {}): WireRef {
    const sha256 = new Bun.SHA256().update(bytes).digest("hex");
    if (this.archive) {
      const wire: WireMetadata = { sha256, bytes: bytes.byteLength, representation: "unavailable",
        ...(headers.contentType ? { contentType: headers.contentType } : {}),
        ...(headers.contentEncoding ? { contentEncoding: headers.contentEncoding } : {}) };
      let value: unknown;
      try {
        const encoding = headers.contentEncoding?.trim().toLowerCase();
        if (encoding && !["identity", "gzip"].includes(encoding)) throw new Error("unsupported-content-encoding");
        const decoded = encoding === "gzip" || bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        try { value = JSON.parse(text); wire.representation = "json"; }
        catch {
          // Valid UTF-8 alone is insufficient: control bytes often indicate a
          // binary body. Such bytes stay diagnostics, never a second media store.
          if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("binary-body");
          value = text; wire.representation = "text";
        }
      } catch { value = { unavailable: "Body is not supported UTF-8 text or JSON" }; }
      // The archive preserves JSON meaning, not original whitespace/compression.
      // Wire identity remains separate from the content-addressed object identity.
      return { ...this.archive.write(value), wire };
    }
    const path = `payloads/${sha256}.${format}.gz`;
    if (!existsSync(join(this.directory, path))) writeFileSync(join(this.directory, path), gzipSync(bytes));
    return { path, sha256, bytes: bytes.byteLength, encoding: "gzip" };
  }

  stream(path: string, event: unknown, trace: EventTrace, source: EventSource = RSA_SOURCE) {
    let stored = event, format: string | undefined;
    if (this.archive && event && typeof event === "object" && "data" in event && typeof event.data === "string") {
      const input = event as { event?: string; data: string; raw?: string[] };
      let data: unknown = input.data, dataFormat = "text";
      try { data = JSON.parse(input.data); dataFormat = "json"; } catch { /* Non-JSON SSE and [DONE] remain text. */ }
      let line = 0;
      stored = { event: input.event, dataRef: this.archive.write(data, { inline: true }), dataFormat,
        dataSha256: new Bun.SHA256().update(input.data).digest("hex"), dataBytes: Buffer.byteLength(input.data),
        raw: input.raw?.map(value => value.startsWith("data:")
          ? { data: true, prefix: value.startsWith("data: ") ? "data: " : "data:", line: line++ } : value) };
      format = "rsa-stream-v1";
    }
    appendFileSync(join(this.directory, path), JSON.stringify({ at: new Date().toISOString(), atMs: this.clock.now(), source, trace,
      ...(format ? { format } : {}), event: stored }) + "\n");
  }
}
