import type { EventLog } from "../harness/events.ts";

/** Local program inputs supplied by Shiori, not a second runner contract. */
export interface BenchmarkContext {
  runDir: string; workspace: string; log: EventLog;
  metadata: { conditions?: Record<string, unknown>; subjects?: unknown[]; artifacts?: unknown[]; limitations?: string[] };
  model: string; seconds: number; maxRequests: number; seed: number; signal?: AbortSignal;
}
