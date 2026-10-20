/** Shared, runtime-independent RSA Benchmark contract (CLI, Python SDK, Dashboard). */
export interface BenchmarkDefinition {
  id: string;
  title: string;
  description: string;
  scope: string;
  revision: string;
  source: "builtin" | "workspace";
  mode: "offline" | "live";
  parameters: Record<string, unknown>;
  targets: string[];
  entry: { kind: "builtin"; caseId: string } | { kind: "python"; path: string; function: string; codeSHA: string };
}
export interface BenchmarkCheck {
  id: string; label: string; passed: boolean | null;
  expected: string; actual: string; evidenceSeq: number[];
}
export interface BenchmarkMetric {
  id: string; label?: string; value: number | null; unit: string;
  direction?: "lower" | "higher" | "none";
}
export interface BenchmarkReference {
  id: string; path?: string; sha256?: string; revision?: string;
}
export interface BenchmarkArtifact { path: string; label?: string }
export interface CaseOutcome {
  checks: BenchmarkCheck[]; metrics: BenchmarkMetric[];
  conditions?: Record<string, unknown>; subjects?: BenchmarkReference[];
  artifacts?: BenchmarkArtifact[]; limitations?: string[];
}
export type BenchmarkStatus = "running" | "completed" | "error" | "cancelled" | "skipped";
export type BenchmarkVerdict = "passed" | "failed" | "inconclusive" | null;
export interface BenchmarkResult extends CaseOutcome {
  schemaVersion: 2;
  definition: BenchmarkDefinition;
  status: BenchmarkStatus;
  verdict: BenchmarkVerdict;
  startedAt: string; endedAt: string | null; durationMs: number | null;
  runId: string; project: string; workspace: string;
  parentRunId?: string;
  trace: Record<string, string>;
  parameters: Record<string, unknown>;
  provenance: Record<string, unknown>;
  error?: string;
}
export function outcomeVerdict(outcome: CaseOutcome): BenchmarkVerdict {
  if (outcome.checks.some(check => check.passed === false)) return "failed";
  if (outcome.checks.some(check => check.passed === null)) return "inconclusive";
  return outcome.checks.length ? "passed" : null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export function validateDefinition(definition: BenchmarkDefinition): void {
  if (!object(definition) || !nonempty(definition.id) || !nonempty(definition.revision) ||
    !["title", "description", "scope"].every(key => typeof definition[key] === "string") ||
    !["builtin", "workspace"].includes(definition.source) || !["offline", "live"].includes(definition.mode) ||
    !object(definition.parameters) || !Array.isArray(definition.targets) || !definition.targets.every(nonempty) ||
    !object(definition.entry)) throw new Error("Invalid benchmark definition");
  const entry = definition.entry;
  if (entry.kind === "builtin" ? !nonempty(entry.caseId) : entry.kind !== "python" ||
    !nonempty(entry.path) || !nonempty(entry.function) || !nonempty(entry.codeSHA)) throw new Error("Invalid benchmark entry");
}
export function validateOutcome(outcome: CaseOutcome): void {
  if (!outcome || !Array.isArray(outcome.checks) || !Array.isArray(outcome.metrics)) throw new Error("Benchmark must return checks and metrics arrays");
  for (const metric of outcome.metrics) {
    if (!object(metric) || !nonempty(metric.id) || typeof metric.unit !== "string" ||
      (metric.label !== undefined && typeof metric.label !== "string") ||
      (metric.value !== null && (typeof metric.value !== "number" || !Number.isFinite(metric.value))) ||
      (metric.direction !== undefined && !["lower", "higher", "none"].includes(metric.direction))) throw new Error("Invalid benchmark metric");
  }
  for (const check of outcome.checks) {
    if (!object(check) || !nonempty(check.id) || ![true, false, null].includes(check.passed) ||
      !["label", "expected", "actual"].every(key => typeof check[key] === "string") || !Array.isArray(check.evidenceSeq) ||
      check.evidenceSeq.some(seq => !Number.isSafeInteger(seq) || seq < 1)) throw new Error("Invalid benchmark check");
  }
  for (const items of [outcome.metrics, outcome.checks]) {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("Benchmark metric/check IDs must be unique");
  }
  if (outcome.conditions !== undefined && !object(outcome.conditions)) throw new Error("Invalid benchmark conditions");
  if (outcome.subjects !== undefined && (!Array.isArray(outcome.subjects) || outcome.subjects.some(item => !object(item) || !nonempty(item.id) ||
    ["path", "sha256", "revision"].some(key => item[key] !== undefined && typeof item[key] !== "string")))) throw new Error("Invalid benchmark subjects");
  if (outcome.artifacts !== undefined && (!Array.isArray(outcome.artifacts) || outcome.artifacts.some(item => !object(item) || !nonempty(item.path) ||
    item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").includes("..") ||
    (item.label !== undefined && typeof item.label !== "string")))) throw new Error("Artifacts must be relative to the benchmark run");
  if (outcome.limitations !== undefined && (!Array.isArray(outcome.limitations) || outcome.limitations.some(item => typeof item !== "string"))) throw new Error("Invalid benchmark limitations");
}
export function validateResult(result: BenchmarkResult): void {
  if (!result || result.schemaVersion !== 2 || !nonempty(result.runId) || !nonempty(result.project) || !nonempty(result.workspace) ||
    typeof result.startedAt !== "string" || (result.endedAt !== null && typeof result.endedAt !== "string") ||
    (result.durationMs !== null && (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0)) ||
    !object(result.parameters) || !object(result.provenance) || !object(result.trace) ||
    !["running", "completed", "error", "cancelled", "skipped"].includes(result.status)) throw new Error("Unsupported or invalid benchmark result");
  validateDefinition(result.definition);
  validateOutcome(result);
  if (result.verdict !== (result.status === "completed" ? outcomeVerdict(result) : null)) throw new Error("Benchmark verdict does not match execution/checks");
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
/** Condition changes are visible; subject changes are the intended comparison. */
export function comparisonChanges(result: BenchmarkResult, baseline: BenchmarkResult): string[] {
  return [
    ["评测定义", result.definition.revision, baseline.definition.revision],
    ["运行模式", result.definition.mode, baseline.definition.mode],
    ["参数", result.parameters, baseline.parameters],
    ["评测条件", result.conditions ?? {}, baseline.conditions ?? {}],
  ].filter(([, a, b]) => canonical(a) !== canonical(b)).map(([label]) => label as string);
}
export function compatibleBaseline(result: BenchmarkResult, baseline: BenchmarkResult): boolean {
  return result.definition.id === baseline.definition.id && comparisonChanges(result, baseline).length === 0;
}
export function compareResults(result: BenchmarkResult, baseline: BenchmarkResult) {
  return { compatible: compatibleBaseline(result, baseline), changes: comparisonChanges(result, baseline),
    subjectsChanged: canonical(result.subjects ?? []) !== canonical(baseline.subjects ?? []),
    metrics: result.metrics.map(metric => {
      const previous = baseline.metrics.find(item => item.id === metric.id);
      const comparable = !!previous && previous.unit === metric.unit && (previous.direction ?? "none") === (metric.direction ?? "none");
      return { id: metric.id, unit: metric.unit, comparable, value: metric.value, baseline: previous?.value ?? null,
        delta: comparable && metric.value !== null && previous!.value !== null ? metric.value - previous!.value! : null };
    }) };
}
