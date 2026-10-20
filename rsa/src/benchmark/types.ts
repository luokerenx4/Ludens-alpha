import type { EventLog } from "../harness/events.ts";
export * from "./contract.ts";
export interface BenchmarkContext {
  runDir: string; workspace: string; log: EventLog;
  model: string; seconds: number; maxRequests: number; seed: number; signal?: AbortSignal;
}
