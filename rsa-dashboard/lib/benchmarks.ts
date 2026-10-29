import type { Event } from "./types";
import type { BenchmarkResult, EvidenceReference, TaskDefinition, TrialSummary, TrialPage, VerificationPage, VerificationStatus, TrialStatus } from "../../rsa/src/benchmark/contract";
import type { TaskWithBindings } from "../../rsa/src/benchmark/bindings";
export { compareResults, comparisonChanges } from "../../rsa/src/benchmark/contract";
export type { BenchmarkResult, EvidenceReference, TaskDefinition, TrialSummary, Trial, Verification, VerificationSummary } from "../../rsa/src/benchmark/contract";

export interface BenchmarkQuery { project?: string; taskName?: string; cursor?: string; limit?: number }
export interface BenchmarkDetailQuery { verification?: string; verificationCursor?: string; evidenceCursor?: string }
export interface BenchmarkCatalog {
  projects: { id: string; workspace: string }[];
  project: string | null;
  tasks: TaskWithBindings[];
  history: TrialPage;
  issues: { project: string; error: string }[];
}
export interface BenchmarkEvidenceItem {
  index: number;
  reference: EvidenceReference;
  available: boolean;
  error?: string;
  event?: Event;
}
export interface BenchmarkAttachment { reference: EvidenceReference; text: string; truncated: boolean }
export interface BenchmarkEvidence {
  result: BenchmarkResult;
  verifications: VerificationPage;
  evidence: { items: BenchmarkEvidenceItem[]; nextCursor?: string };
}
export const statusLabels: Record<TrialStatus, string> = {
  running: "尚未记录结束", completed: "执行完成", error: "执行异常", cancelled: "已取消",
};
export const verificationLabels: Record<VerificationStatus, string> = {
  running: "评分中", completed: "评分完成", error: "评分异常",
};
export const verificationLabel = (value: BenchmarkResult["verification"]) => value ? verificationLabels[value.status] : "尚未评分";
export const resultLabel = (value: BenchmarkResult) => `${statusLabels[value.trial.status]} · ${verificationLabel(value.verification)}`;
export const resultKey = (value: Pick<TrialSummary, "project" | "runId">) => `${value.project}/${value.runId}`;
export const taskKey = (value: TaskDefinition) => `${value.name}@${value.digest}`;
export function parseResultKey(value: string | null): { project: string; run: string } | null {
  if (!value) return null;
  const [project, run, extra] = value.split("/");
  return project && run && !extra && [project, run].every(id => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) ? { project, run } : null;
}
export function benchmarkRunUrl(trial: Pick<TrialSummary, "project" | "runId">, event?: Event, reference?: EvidenceReference) {
  const params = new URLSearchParams({ view: "benchmark", project: trial.project,
    run: reference?.kind === "event" ? reference.runId : trial.runId });
  if (event?.trace?.epoch) params.set("epoch", event.trace.epoch);
  if (event?.trace?.modelCallId) params.set("call", event.trace.modelCallId);
  return "/?" + params;
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function benchmarkCommand(task: TaskWithBindings, workspace: string, bindingPath?: string): string | null {
  const binding = bindingPath ? task.bindings.find(item => item.path === bindingPath) : task.bindings.length === 1 ? task.bindings[0] : undefined;
  if (!binding) return null;
  return `rsa --workspace ${shellQuote(workspace)} bench run ${shellQuote(task.name)} --digest ${shellQuote(task.digest)} --config ${shellQuote(binding.path)}`;
}
export function benchmarkVerifyCommand(trial: Pick<TrialSummary, "workspace" | "runId">) {
  return `rsa --workspace ${shellQuote(trial.workspace)} bench verify ${shellQuote(trial.runId)}`;
}
/** URL selections pin a verification, never count a re-score as another execution. */
export function benchmarkSelection(result: BenchmarkResult, baseline?: BenchmarkResult) {
  return { project: result.trial.project, case: result.trial.task.name, caseDigest: result.trial.task.digest, result: resultKey(result.trial),
    verification: result.verification?.id ?? null, baseline: baseline ? resultKey(baseline.trial) : null,
    baselineVerification: baseline?.verification?.id ?? null, report: null, baselineReport: null };
}
export function evidenceLabel(reference: EvidenceReference) {
  if (reference.label) return reference.label;
  if (reference.kind === "event") return `${reference.runId} · ${reference.eventId ?? `${reference.source ?? "source"} #${reference.seq ?? "prefix"}`}`;
  if (reference.kind === "timeline") return reference.recordId ?? reference.timeline.asset;
  return reference.path;
}
export function parseBenchmarkRequest(params: URLSearchParams):
  | { kind: "catalog"; query: BenchmarkQuery }
  | { kind: "detail"; project: string; run: string; query: BenchmarkDetailQuery }
  | { kind: "attachment"; project: string; run: string; index: number; verification?: string } {
  const project = params.get("project") || undefined, run = params.get("run") || undefined;
  const verification = params.get("verification") ?? params.get("report") ?? undefined;
  const verificationCursor = params.get("verificationCursor") || undefined, evidenceCursor = params.get("evidenceCursor") || undefined;
  if (run && !project) throw new Error("执行详情需要 project 和 run");
  const attachment = params.get("attachment");
  if ((verification || verificationCursor || evidenceCursor || attachment !== null) && !run) throw new Error("评分和证据查询需要 project 和 run");
  if (attachment !== null) {
    const index = Number(attachment);
    if (!/^\d+$/.test(attachment) || !Number.isSafeInteger(index)) throw new Error("无效的附件序号");
    return { kind: "attachment", project: project!, run: run!, index, verification };
  }
  if (project && run) return { kind: "detail", project, run, query: { verification, verificationCursor, evidenceCursor } };
  const limitText = params.get("limit"), limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new Error("limit 必须是 1 到 100 的整数");
  return { kind: "catalog", query: { project, taskName: params.get("task") || undefined, cursor: params.get("cursor") || undefined, limit } };
}
