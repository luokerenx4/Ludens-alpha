import type { Event } from "./types";

export type BenchmarkStatus =
  "running" | "passed" | "failed" | "inconclusive" | "error" | "skipped";
export interface BenchmarkCase {
  id: string;
  version: number;
  title: string;
  mode: "offline" | "live";
  description: string;
  scope: string;
}
export interface BenchmarkResult {
  schemaVersion: 1;
  caseId: string;
  caseVersion: number;
  title: string;
  mode: "offline" | "live";
  status: BenchmarkStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  runId: string;
  project: string;
  parameters: {
    model: string | null;
    seconds: number;
    maxRequests: number;
    seed: number;
  };
  provenance: {
    code: { commit: string; dirty: boolean } | null;
    prompts: Record<string, string>;
    workspaceInstructionsSHA256: string;
  };
  checks: {
    id: string;
    label: string;
    passed: boolean | null;
    expected: string;
    actual: string;
    evidenceSeq: number[];
  }[];
  metrics: {
    id: string;
    label: string;
    value: number | null;
    unit: string;
    direction?: "lower" | "higher" | "none";
  }[];
  limitations?: string[];
  error?: string;
}
export interface BenchmarkCatalog {
  cases: BenchmarkCase[];
  results: BenchmarkResult[];
  issues: { project: string; runId: string; error: string }[];
}
export interface BenchmarkEvidence {
  result: BenchmarkResult;
  events: Event[];
  missingSeq: number[];
  epoch: string | null;
  epochs: string[];
}
export const statusLabels: Record<BenchmarkStatus, string> = {
  running: "运行中",
  passed: "通过",
  failed: "未通过",
  inconclusive: "证据不足",
  error: "执行异常",
  skipped: "已跳过",
};
export const resultKey = (result: BenchmarkResult) =>
  `${result.project}/${result.runId}`;
export function compatibleBaseline(
  result: BenchmarkResult,
  baseline: BenchmarkResult,
) {
  return (
    result.caseId === baseline.caseId &&
    result.caseVersion === baseline.caseVersion &&
    result.mode === baseline.mode
  );
}
export function comparisonChanges(
  result: BenchmarkResult,
  baseline: BenchmarkResult,
) {
  const labels = {
    model: "模型",
    seconds: "时限",
    maxRequests: "请求预算",
    seed: "随机种子",
  };
  return (Object.keys(labels) as (keyof typeof labels)[])
    .filter((key) => result.parameters[key] !== baseline.parameters[key])
    .map((key) => labels[key]);
}
export function benchmarkRunUrl(
  result: BenchmarkResult,
  epoch?: string | null,
  event?: Event,
) {
  const params = new URLSearchParams({
    view: "benchmark",
    project: result.project,
    run: result.runId,
  });
  if (epoch) params.set("epoch", epoch);
  if (event?.trace.modelCallId) params.set("call", event.trace.modelCallId);
  return "/?" + params;
}
