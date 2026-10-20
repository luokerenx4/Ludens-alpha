import type { Event } from "./types";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  BenchmarkStatus,
  BenchmarkVerdict,
} from "../../rsa/src/benchmark/contract";
export {
  compatibleBaseline,
  comparisonChanges,
  compareResults,
} from "../../rsa/src/benchmark/contract";
export type {
  BenchmarkDefinition,
  BenchmarkResult,
  BenchmarkStatus,
  BenchmarkVerdict,
} from "../../rsa/src/benchmark/contract";

export interface BenchmarkEntry {
  key: string;
  definition: BenchmarkDefinition;
  project?: string;
  workspace?: string;
  available: boolean;
}
export interface BenchmarkCatalog {
  benchmarks: BenchmarkEntry[];
  results: BenchmarkResult[];
  issues: { project: string; runId?: string; error: string }[];
}
export interface BenchmarkEvidence {
  result: BenchmarkResult;
  events: Event[];
  missingSeq: number[];
  epoch: string | null;
  epochs: string[];
}
export const statusLabels: Record<BenchmarkStatus, string> = {
  running: "未记录结束",
  completed: "已完成",
  error: "执行异常",
  cancelled: "已取消",
  skipped: "已跳过",
};
export const verdictLabels: Record<Exclude<BenchmarkVerdict, null>, string> = {
  passed: "通过",
  failed: "未通过",
  inconclusive: "证据不足",
};
export const resultLabel = (result: BenchmarkResult) =>
  statusLabels[result.status] +
  (result.verdict ? ` · ${verdictLabels[result.verdict]}` : "");
export const resultKey = (result: BenchmarkResult) =>
  `${result.project}/${result.runId}`;
export const definitionKey = (
  definition: BenchmarkDefinition,
  project?: string,
) =>
  `${definition.source === "builtin" ? "builtin" : project}/${definition.id}`;
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
const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
export function benchmarkCommand(entry: BenchmarkEntry) {
  return `rsa${entry.workspace ? ` --workspace ${shellQuote(entry.workspace)}` : ""} bench run ${shellQuote(entry.definition.id)}${entry.definition.mode === "live" ? " --live" : ""}`;
}
