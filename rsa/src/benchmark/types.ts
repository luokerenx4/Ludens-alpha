import type { EventLog } from "../harness/events.ts";
import type { SharedBudget } from "../harness/runtime.ts";

/** Local program inputs supplied by Shiori, not a second runner contract. */
export interface BenchmarkContext {
  runDir: string; workspace: string; log: EventLog;
  metadata: { conditions?: Record<string, unknown>; subjects?: unknown[]; artifacts?: unknown[]; limitations?: string[] };
  model: string; seconds: number; maxRequests: number; seed: number; signal?: AbortSignal;
  /** Stops measured control, not post-run fact collection. signal above is user cancellation only. */
  budget: SharedBudget;
}
