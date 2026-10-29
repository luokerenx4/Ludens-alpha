import { parseResultKey, taskKey, type BenchmarkCatalog } from "../lib/benchmarks";

type BenchmarkTask = BenchmarkCatalog["tasks"][number];

/** A name+digest identifies one task; use the same local-copy preference as the CLI resolver. */
export function benchmarkTaskChoices(tasks: BenchmarkTask[]): BenchmarkTask[] {
  const choices = new Map<string, BenchmarkTask>();
  for (const task of tasks) {
    const key = taskKey(task), previous = choices.get(key);
    if (!previous || (previous.source !== "workspace" && task.source === "workspace")) choices.set(key, task);
  }
  return [...choices.values()];
}

export type BenchmarkTaskSelection = { kind: "none" | "missing" | "ambiguous"; task?: undefined }
  | { kind: "selected"; task: BenchmarkTask };

/** Task preparation is independent of the result and baseline selected for inspection. */
export function benchmarkTaskSelection(tasks: BenchmarkTask[], name: string | null, digest: string | null): BenchmarkTaskSelection {
  if (!name) return { kind: "none" };
  const matches = benchmarkTaskChoices(tasks).filter(task => task.name === name && (!digest || task.digest === digest));
  if (!matches.length) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "selected", task: matches[0]! };
}

export function benchmarkTaskFilter(name: string, digest: string) {
  return { case: name, caseDigest: digest, benchCursor: null };
}

export function benchmarkWorkspaceState({ ready, workspace, catalogError, available }: {
  ready: boolean; workspace: string; catalogError: string; available: boolean;
}) {
  if (!ready) return "loading";
  if (!workspace) return catalogError ? "error" : "empty";
  return available ? "ready" : "unavailable";
}
export function benchmarkHistoryState(catalog: BenchmarkCatalog, taskFilter: string | null, cursor: string | null) {
  if (catalog.history.trials.length) return "ready";
  if (catalog.history.issues.length) return "unreadable";
  if (cursor) return "page-empty";
  if (taskFilter) return "filter-empty";
  if (!catalog.tasks.length && catalog.issues.length) return "tasks-unavailable";
  return catalog.tasks.length ? "no-runs" : "no-tasks";
}
const reference = (key: string | null) => key?.split("/").length === 2 ? parseResultKey(key) : null;
export const benchmarkReferenceState = (key: string | null) => key === null ? "none" : reference(key) ? "valid" : "invalid";
export const clearBenchmarkResult = { result: null, verification: null, report: null, verificationCursor: null, evidenceCursor: null };
export const clearBenchmarkBaseline = { baseline: null, baselineVerification: null, baselineReport: null };
export const clearBenchmarkFilter = { case: null, caseDigest: null, benchCursor: null };
export function benchmarkDetailUrl(key: string | null, verification?: string | null, cursors?: { verification?: string | null; evidence?: string | null }) {
  const identity = reference(key);
  if (!identity) return null;
  const params = new URLSearchParams(identity);
  if (verification) params.set("verification", verification);
  if (cursors?.verification) params.set("verificationCursor", cursors.verification);
  if (cursors?.evidence) params.set("evidenceCursor", cursors.evidence);
  return "/api/benchmarks?" + params;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function benchmarkListCommand(workspace: string) { return `rsa --workspace ${quote(workspace)} bench list`; }
export function benchmarkTaskHelpCommand(workspace: string, name: string, digest: string) {
  return `rsa --workspace ${quote(workspace)} bench help ${quote(name)} --digest ${quote(digest)}`;
}
export function benchmarkGuidanceLinks(workspace: string, locale: "en" | "zh") {
  const url = (params: Record<string, string>) => "/?" + new URLSearchParams(params);
  const docs = (doc: string) => url({ view: "docs", doc, docLang: locale, ...(workspace ? { project: workspace } : {}) });
  return { workspaces: url({ view: "workspaces" }), guide: docs("reference/benchmark"),
    quickstart: docs("tutorials/quickstart"),
    capabilities: workspace ? url({ view: "caps", project: workspace }) : null };
}
