import type { TimelineAssetReference } from "../../../shared/timeline-types";

/** Runtime-independent benchmark contract. Reports never rewrite execution facts. */
export interface BenchmarkDefinition {
  id: string; title: string; description: string; scope: string;
  revision: string; protocolVersion: string;
  source: "builtin" | "workspace";
  parameters: Record<string, unknown>; targets: string[];
  entry: { kind: "builtin"; caseId: string } | { kind: "python"; path: string; function: string; codeSHA: string };
}
export interface BenchmarkCheck {
  id: string; label: string; passed: boolean | null;
  expected?: unknown; actual?: unknown; evidenceSeq: number[];
}
export interface BenchmarkMetric {
  id: string; label?: string; value: number | null; unit: string;
  direction?: "lower" | "higher" | "none"; reason?: string;
}
export interface AuthorReport {
  checks?: Record<string, Omit<BenchmarkCheck, "id" | "label" | "evidenceSeq"> & { label?: string; evidenceSeq?: number[] }>;
  metrics?: Record<string, Omit<BenchmarkMetric, "id">>;
}
export interface BenchmarkReference { id: string; path?: string; sha256?: string; revision?: string }
export interface BenchmarkArtifact {
  /** Run-relative archive, or workspace-relative original when timeline is present. */
  path: string; label?: string; sha256?: string;
  timeline?: TimelineAssetReference & { recordId?: string; sequence?: number };
  mediaType?: string; approximate?: boolean;
}
export interface CaseMetadata {
  conditions?: Record<string, unknown>; subjects?: BenchmarkReference[];
  artifacts?: BenchmarkArtifact[]; limitations?: string[];
}
export interface CaseOutcome { checks: BenchmarkCheck[]; metrics: BenchmarkMetric[] }
export interface ReportIssue { path: string; message: string }
export interface BenchmarkReport {
  schemaVersion: 1; id: string; runId: string; createdAt: string;
  previousReportId: string | null; reason: string; protocolVersion: string;
  raw: unknown; rawText?: string; errors: ReportIssue[]; outcome: CaseOutcome | null;
}
export type BenchmarkStatus = "running" | "completed" | "error" | "cancelled";
export type BenchmarkVerdict = "passed" | "failed" | "inconclusive" | null;
export interface BenchmarkExecution extends CaseMetadata {
  schemaVersion: 3; definition: BenchmarkDefinition; status: BenchmarkStatus;
  startedAt: string; endedAt: string | null; durationMs: number | null;
  runId: string; project: string; workspace: string; parentRunId?: string;
  trace: Record<string, string>; parameters: Record<string, unknown>; provenance: Record<string, unknown>;
  error?: string; errorPhase?: "load" | "execute";
}
/** Read projection: one execution, one explicitly selected (or latest) report. */
export interface BenchmarkResult extends BenchmarkExecution, CaseOutcome {
  verdict: BenchmarkVerdict; report: BenchmarkReport | null; reports: BenchmarkReport[];
}
export function outcomeVerdict(outcome: CaseOutcome): BenchmarkVerdict {
  if (outcome.checks.some(check => check.passed === false)) return "failed";
  if (outcome.checks.some(check => check.passed === null)) return "inconclusive";
  return outcome.checks.length ? "passed" : null;
}
/** Lifecycle events distinguish execution from the selected report's assessment. */
export interface BenchmarkEventSummary {
  benchmarkId: string; benchmarkRunId: string; executionStatus: BenchmarkStatus;
  reportStatus: "missing" | "valid" | "invalid"; verdict: BenchmarkVerdict;
  reportId: string | null; previousReportId: string | null;
}
export function benchmarkEventSummary(execution: BenchmarkExecution, report?: BenchmarkReport | null): BenchmarkEventSummary {
  return { benchmarkId: execution.definition.id, benchmarkRunId: execution.runId,
    executionStatus: execution.status, reportStatus: !report ? "missing" : report.outcome ? "valid" : "invalid",
    verdict: execution.status === "completed" && report?.outcome ? outcomeVerdict(report.outcome) : null,
    reportId: report?.id ?? null, previousReportId: report?.previousReportId ?? null };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export function validateDefinition(definition: BenchmarkDefinition): void {
  if (!object(definition) || !nonempty(definition.id) || !nonempty(definition.revision) || !nonempty(definition.protocolVersion) ||
    !["title", "description", "scope"].every(key => typeof definition[key] === "string") ||
    !["builtin", "workspace"].includes(definition.source) || !object(definition.parameters) ||
    !Array.isArray(definition.targets) || !definition.targets.every(nonempty) || !object(definition.entry)) throw new Error("Invalid benchmark definition");
  const entry = definition.entry;
  if (entry.kind === "builtin" ? !nonempty(entry.caseId) : entry.kind !== "python" ||
    !nonempty(entry.path) || !nonempty(entry.function) || !nonempty(entry.codeSHA)) throw new Error("Invalid benchmark entry");
}
export function validateExecution(result: BenchmarkExecution): void {
  if (!result || result.schemaVersion !== 3 || !nonempty(result.runId) || !nonempty(result.project) || !nonempty(result.workspace) ||
    typeof result.startedAt !== "string" || (result.endedAt !== null && typeof result.endedAt !== "string") ||
    (result.durationMs !== null && (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0)) ||
    !object(result.parameters) || !object(result.provenance) || !object(result.trace) ||
    !["running", "completed", "error", "cancelled"].includes(result.status)) throw new Error("Unsupported or invalid benchmark execution (expected schemaVersion 3)");
  validateDefinition(result.definition);
}
export function validateReport(report: BenchmarkReport, runId: string): void {
  if (!report || report.schemaVersion !== 1 || report.runId !== runId || !nonempty(report.id) || !nonempty(report.createdAt) ||
    !nonempty(report.protocolVersion) || typeof report.reason !== "string" ||
    (report.previousReportId !== null && !nonempty(report.previousReportId)) || !Array.isArray(report.errors) ||
    report.errors.some(error => typeof error.path !== "string" || typeof error.message !== "string") ||
    (report.outcome === null ? !report.errors.length : report.errors.length || !Array.isArray(report.outcome.checks) || !Array.isArray(report.outcome.metrics))) {
    throw new Error("Invalid benchmark report record");
  }
}
export function projectResult(execution: BenchmarkExecution, reports: BenchmarkReport[], reportId?: string): BenchmarkResult {
  const report = reportId ? reports.find(item => item.id === reportId) : reports.at(-1) ?? null;
  if (reportId && !report) throw new Error(`Benchmark report not found: ${reportId}`);
  const outcome = report?.outcome ?? { checks: [], metrics: [] };
  return { ...execution, ...outcome, reports, report: report ?? null,
    verdict: execution.status === "completed" && report?.outcome ? outcomeVerdict(outcome) : null };
}
export function validateResult(result: BenchmarkResult): void {
  validateExecution(result);
  if (!Array.isArray(result.reports)) throw new Error("Missing benchmark reports");
  for (const report of result.reports) validateReport(report, result.runId);
  if (result.report) validateReport(result.report, result.runId);
  if (result.verdict !== (result.status === "completed" && result.report?.outcome ? outcomeVerdict(result.report.outcome) : null)) {
    throw new Error("Benchmark verdict does not match execution/report");
  }
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export function comparisonChanges(result: BenchmarkResult, baseline: BenchmarkResult): string[] {
  return [
    ["评测身份", result.definition.id, baseline.definition.id],
    ["评测口径", result.report?.protocolVersion ?? result.definition.protocolVersion, baseline.report?.protocolVersion ?? baseline.definition.protocolVersion],
    ["参数", result.parameters, baseline.parameters],
    ["评测条件", result.conditions ?? {}, baseline.conditions ?? {}],
  ].filter(([, a, b]) => canonical(a) !== canonical(b)).map(([label]) => label as string);
}
export function compatibleBaseline(result: BenchmarkResult, baseline: BenchmarkResult): boolean {
  return result.status === "completed" && baseline.status === "completed" && !!result.report?.outcome && !!baseline.report?.outcome && comparisonChanges(result, baseline).length === 0;
}
export function compareResults(result: BenchmarkResult, baseline: BenchmarkResult) {
  return { compatible: compatibleBaseline(result, baseline), changes: comparisonChanges(result, baseline),
    sameExecution: result.project === baseline.project && result.runId === baseline.runId,
    reports: { result: result.report?.id ?? null, baseline: baseline.report?.id ?? null },
    subjectsChanged: canonical(result.subjects ?? []) !== canonical(baseline.subjects ?? []),
    metrics: result.metrics.map(metric => {
      const previous = baseline.metrics.find(item => item.id === metric.id);
      const comparable = !!previous && previous.unit === metric.unit && (previous.direction ?? "none") === (metric.direction ?? "none");
      return { id: metric.id, unit: metric.unit, comparable, value: metric.value, baseline: previous?.value ?? null,
        delta: comparable && metric.value !== null && previous!.value !== null ? metric.value - previous!.value! : null };
    }) };
}
