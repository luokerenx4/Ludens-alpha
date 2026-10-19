export type Trace = Record<string, unknown>;
export interface DeviceEvent { type: string; data: unknown; trace: Trace }
export type RecordEvent = (type: string, data: unknown, trace?: Trace) => void;
export interface Request {
  kind: "status" | "list" | "help" | "acquire" | "release" | "revoke" | "sensor" | "controller" | "cancel" | "subscribe";
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
