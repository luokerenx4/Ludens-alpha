import type { getActivity, ActivityQuery } from "./activity";
import type { aliceState, recordAliceConsumer, setAliceTarget } from "./alice-state";
import type { benchmarkAttachment, benchmarkCatalog, benchmarkEvidence } from "./benchmark-data";
import type { BenchmarkQuery, BenchmarkDetailQuery } from "./benchmarks";
import type { capabilities } from "./capabilities";
import type { discoverDriver } from "./drivers";
import type { archiveBuild, catalog, getRun, mediaFile, stopRun, timelineRecord } from "./data";
import type { docGroups, readDoc } from "./docs";
import type { getReplay, ReplayQuery } from "./replay";
import type { RunPage } from "./run-index";
import type { diagnosticEvents, DiagnosticQuery } from "./diagnostic-events";
import type { indexCacheStats } from "./log-index";
import type { PerceptionSettings } from "./perception-config";

/** Only existing Dashboard operations cross the worker boundary, never arbitrary code or paths. */
export interface DashboardMethods {
  archiveBuild: { args: [project: string, run: string, action?: "cancel" | "retry", buildId?: string]; result: Awaited<ReturnType<typeof archiveBuild>> };
  diagnosticEvents: { args: [project: string, run: string, query?: DiagnosticQuery]; result: Awaited<ReturnType<typeof diagnosticEvents>> };
  diagnostics: { args: []; result: { memory: NodeJS.MemoryUsage; index: ReturnType<typeof indexCacheStats>; activeRequests: number } };
  catalog: { args: [includeEmpty?: boolean]; result: Awaited<ReturnType<typeof catalog>> };
  run: { args: [project: string, run: string, epoch?: string, page?: RunPage]; result: Awaited<ReturnType<typeof getRun>> };
  activity: { args: [project: string, run?: string, epoch?: string, query?: ActivityQuery]; result: Awaited<ReturnType<typeof getActivity>> };
  replay: { args: [project: string, run: string, query: ReplayQuery]; result: Awaited<ReturnType<typeof getReplay>> };
  media: { args: [project: string, run: string, id: string]; result: Awaited<ReturnType<typeof mediaFile>> };
  timelineRecord: { args: [project: string, run: string, record: string, sequence: number, source: { call?: string; observation?: string }]; result: Awaited<ReturnType<typeof timelineRecord>> };
  benchmarkCatalog: { args: [query?: BenchmarkQuery]; result: Awaited<ReturnType<typeof benchmarkCatalog>> };
  benchmarkEvidence: { args: [project: string, run: string, query?: BenchmarkDetailQuery]; result: Awaited<ReturnType<typeof benchmarkEvidence>> };
  benchmarkAttachment: { args: [project: string, run: string, index: number, verification?: string]; result: Awaited<ReturnType<typeof benchmarkAttachment>> };
  capabilities: { args: [project?: string]; result: Awaited<ReturnType<typeof capabilities>> };
  discoverDriver: { args: [spec: string]; result: Awaited<ReturnType<typeof discoverDriver>> };
  docGroups: { args: []; result: Awaited<ReturnType<typeof docGroups>> };
  readDoc: { args: [id: string]; result: Awaited<ReturnType<typeof readDoc>> };
  stop: { args: [project: string, run: string, epoch: string | null]; result: Awaited<ReturnType<typeof stopRun>> };
  aliceState: { args: []; result: ReturnType<typeof aliceState> };
  aliceTarget: { args: [project: unknown, ifUnset: boolean]; result: Awaited<ReturnType<typeof setAliceTarget>> };
  perceptionSettings: { args: [project: string]; result: PerceptionSettings };
  updatePerceptionSettings: { args: [project: string, patch: unknown]; result: PerceptionSettings };
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
