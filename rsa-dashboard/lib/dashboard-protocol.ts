import type { getActivity, ActivityQuery } from "./activity";
import type { aliceState, recordAliceConsumer, setAliceTarget } from "./alice-state";
import type { benchmarkCatalog, benchmarkEvidence } from "./benchmark-data";
import type { catalog, getRun, mediaFile, stopRun, timelineRecord } from "./data";
import type { getReplay, ReplayQuery } from "./replay";
import type { RunPage } from "./run-index";
import type { indexCacheStats } from "./log-index";

/** Only existing Dashboard operations cross the worker boundary, never arbitrary code or paths. */
export interface DashboardMethods {
  diagnostics: { args: []; result: { memory: NodeJS.MemoryUsage; index: ReturnType<typeof indexCacheStats>; activeRequests: number } };
  catalog: { args: []; result: Awaited<ReturnType<typeof catalog>> };
  run: { args: [project: string, run: string, epoch?: string, page?: RunPage]; result: Awaited<ReturnType<typeof getRun>> };
  activity: { args: [project: string, run?: string, epoch?: string, query?: ActivityQuery]; result: Awaited<ReturnType<typeof getActivity>> };
  replay: { args: [project: string, run: string, query: ReplayQuery]; result: Awaited<ReturnType<typeof getReplay>> };
  media: { args: [project: string, run: string, id: string]; result: Awaited<ReturnType<typeof mediaFile>> };
  timelineRecord: { args: [project: string, run: string, record: string, sequence: number, source: { call?: string; observation?: string }]; result: Awaited<ReturnType<typeof timelineRecord>> };
  benchmarkCatalog: { args: []; result: Awaited<ReturnType<typeof benchmarkCatalog>> };
  benchmarkEvidence: { args: [project: string, run: string, report?: string]; result: Awaited<ReturnType<typeof benchmarkEvidence>> };
  stop: { args: [project: string, run: string, epoch: string | null]; result: Awaited<ReturnType<typeof stopRun>> };
  aliceState: { args: []; result: ReturnType<typeof aliceState> };
  aliceTarget: { args: [project: unknown, ifUnset: boolean]; result: Awaited<ReturnType<typeof setAliceTarget>> };
  aliceConsumer: { args: [input: unknown]; result: ReturnType<typeof recordAliceConsumer> };
}
export type DashboardMethod = keyof DashboardMethods;
export type WorkerRequest = { type: "call"; id: number; method: DashboardMethod; args: unknown[] }
  | { type: "cancel"; id: number } | { type: "close" };
export interface WorkerFailure { name: string; message: string; status?: number; code?: string; progress?: unknown }
export type WorkerResponse = { type: "ready" } | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; error: WorkerFailure };

export function workerFailure(error: unknown): WorkerFailure {
  const value = error as Partial<WorkerFailure> | null;
  return { name: value?.name ?? "Error", message: value?.message ?? String(error),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(value?.progress === undefined ? {} : { progress: value.progress }) };
}
