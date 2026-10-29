import type { getActivity, ActivityQuery } from "./activity";
import type { petState, recordPetConsumer, setPetTarget } from "./pet-state";
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
import type { PerceptionSettings, PerceptionSettingsPatch, PerceptionRuntimeSnapshot } from "./perception-config";
import type { workspaceSettings, updateWorkspaceRoot, openWorkspace, removeWorkspace, createWorkspace } from "./workspaces";

/** Only existing Dashboard operations cross the worker boundary, never arbitrary code or paths. */
export interface DashboardMethods {
  workspaceSettings: { args: []; result: Awaited<ReturnType<typeof workspaceSettings>> };
  updateWorkspaceRoot: { args: [path: unknown]; result: Awaited<ReturnType<typeof updateWorkspaceRoot>> };
  openWorkspace: { args: [path: unknown]; result: Awaited<ReturnType<typeof openWorkspace>> };
  removeWorkspace: { args: [id: unknown]; result: Awaited<ReturnType<typeof removeWorkspace>> };
  createWorkspace: { args: [input: unknown]; result: Awaited<ReturnType<typeof createWorkspace>> };
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
  docGroups: { args: [root?: string, lang?: "en" | "zh"]; result: Awaited<ReturnType<typeof docGroups>> };
  readDoc: { args: [id: string, root?: string, lang?: "en" | "zh"]; result: Awaited<ReturnType<typeof readDoc>> };
  stop: { args: [project: string, run: string, epoch: string | null]; result: Awaited<ReturnType<typeof stopRun>> };
  perceptionSettings: { args: [project: string, workspace: string]; result: Partial<PerceptionSettings> };
  updatePerceptionSettings: { args: [project: string, patch: PerceptionSettingsPatch, workspace: string]; result: Partial<PerceptionSettings> };
  perceptionRuntime: { args: [project: string, workspace: string]; result: PerceptionRuntimeSnapshot };
  petState: { args: []; result: Awaited<ReturnType<typeof petState>> };
  petTarget: { args: [project: unknown, ifUnset: boolean]; result: Awaited<ReturnType<typeof setPetTarget>> };
  petConsumer: { args: [input: unknown]; result: Awaited<ReturnType<typeof recordPetConsumer>> };
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
