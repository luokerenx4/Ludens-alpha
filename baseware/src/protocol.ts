export interface Trace extends Record<string, unknown> { traceId?: string; spanId?: string; parentSpanId?: string }
export interface EventSource { component: string; implementation?: string; implementationVersion?: string }
export interface EventOrigin { eventId: string; clockId: string; seq: number; at: string; atMs: number }
export interface EventMetadata { source?: EventSource; origin?: EventOrigin }
export interface DeviceEvent { type: string; data: unknown; trace: Trace; source: EventSource; origin: EventOrigin }
export type RecordEvent = (type: string, data: unknown, trace?: Trace, metadata?: EventMetadata) => void;
import type { CommandSchema, JsonSchema } from "./contracts.ts";

/** Serializable service discovery; driver implementation objects never cross this boundary. */
export interface Catalog {
  drivers: { id: string; version: string }[];
  controllers: { id: string; requiresControl: boolean; mediaTypes?: readonly string[]; help: string;
    commands?: CommandSchema[]; stdoutSchema?: JsonSchema }[];
}
export interface Request {
  kind: "status" | "list" | "help" | "acquire" | "release" | "revoke" | "controller" | "cancel" | "subscribe";
  id?: string;
  argv?: string[];
  epoch?: string;
  seconds?: number;
  trace?: Trace;
  origin?: string;
  operationId?: string;
}
export interface Envelope { id: string; request: Request }
export type Response = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string };
export type Message = Response | { event: DeviceEvent };
