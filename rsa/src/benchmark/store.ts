import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { resolveWorkspaceState } from "../harness/workspace-state.ts";
import { benchmarkEventSummary, projectResult, validateExecution, validateReport, type BenchmarkExecution, type BenchmarkReport, type BenchmarkResult } from "./contract.ts";
import { jsonIssues, validateAuthorReport } from "./report.ts";

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}
export async function indexWorkspace(workspace: string, artifactRoot: string) {
  const state = await resolveWorkspaceState(workspace, artifactRoot);
  await mkdir(join(state.workspace, "logs"), { recursive: true });
  await atomicJson(join(state.dir, "workspace.json"), { workspace: state.workspace });
  return state;
}
export async function writeResult(runDir: string, result: BenchmarkExecution) {
  validateExecution(result);
  await atomicJson(join(runDir, "benchmark.json"), result);
}
export async function readExecution(workspace: string, runId: string): Promise<BenchmarkExecution> {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId) || [".", ".."].includes(runId)) throw new Error("Invalid benchmark run ID");
  const root = await realpath(join(workspace, "logs"));
  const file = join(root, runId, "benchmark.json");
  if (await realpath(file) !== file) throw new Error("Benchmark result must belong to the workspace logs");
  const result: BenchmarkExecution = JSON.parse(await readFile(file, "utf8"));
  validateExecution(result);
  if (result.runId !== runId || result.workspace !== await realpath(workspace)) throw new Error("Benchmark result identity mismatch");
  return result;
}
export async function readReports(runDir: string, runId: string): Promise<BenchmarkReport[]> {
  const entries = await readdir(join(runDir, "reports")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const reports = await Promise.all(entries.filter(name => name.endsWith(".json") && !name.endsWith(".raw.json")).sort().map(async name => {
    const report: BenchmarkReport = JSON.parse(await readFile(join(runDir, "reports", name), "utf8"));
    validateReport(report, runId);
    if (name !== `${report.id}.json`) throw new Error("Benchmark report identity mismatch");
    return report;
  }));
  // A report's parent, not its timestamp/UUID, establishes revision order.
  const byId = new Map(reports.map(report => [report.id, report]));
  const ordered: BenchmarkReport[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (report: BenchmarkReport) => {
    if (visited.has(report.id)) return;
    if (visiting.has(report.id)) throw new Error("Cyclic benchmark report revision chain");
    visiting.add(report.id);
    if (report.previousReportId) {
      const parent = byId.get(report.previousReportId);
      if (!parent) throw new Error(`Missing parent report: ${report.previousReportId}`);
      visit(parent);
    }
    visiting.delete(report.id); visited.add(report.id); ordered.push(report);
  };
  for (const report of reports) visit(report);
  return ordered;
}
export async function readResult(workspace: string, runId: string, reportId?: string): Promise<BenchmarkResult> {
  const execution = await readExecution(workspace, runId);
  return projectResult(execution, await readReports(join(workspace, "logs", runId), runId), reportId);
}
/** Append a report only: no import, worker, model call, or device access. */
export async function saveReport(runDir: string, execution: BenchmarkExecution, raw: unknown,
  options: { reason?: string; protocolVersion?: string } = {}): Promise<BenchmarkReport> {
  if (execution.status === "running") throw new Error("Wait until the benchmark execution has ended before submitting a report");
  const previous = (await readReports(runDir, execution.runId)).at(-1);
  const protocolVersion = options.protocolVersion ?? previous?.protocolVersion ?? execution.definition.protocolVersion;
  if (!protocolVersion.trim()) throw new Error("Report protocol version must be nonempty");
  const createdAt = new Date().toISOString(), id = `${createdAt.replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(runDir, "reports");
  await mkdir(directory, { recursive: true });
  const serializationErrors = jsonIssues(raw);
  const rawRecord = serializationErrors.length ? { raw: null, rawText: inspect(raw, { depth: null, maxArrayLength: null }) }
    : { raw: JSON.parse(JSON.stringify(raw)) as unknown };
  // Preserve the returned value before running validation. A crash here still leaves evidence.
  await atomicJson(join(directory, `${id}.raw.json`), rawRecord);
  const report: BenchmarkReport = { schemaVersion: 1, id, runId: execution.runId, createdAt,
    previousReportId: previous?.id ?? null, reason: options.reason ?? "initial", protocolVersion,
    ...rawRecord, ...(serializationErrors.length ? { errors: serializationErrors, outcome: null } : validateAuthorReport(rawRecord.raw)) };
  validateReport(report, execution.runId);
  await atomicJson(join(directory, `${id}.json`), report);
  return report;
}
export async function history(workspace: string, benchmarkId?: string) {
  const entries = await readdir(join(workspace, "logs"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const results: BenchmarkResult[] = [], issues: { runId: string; error: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const result = await readResult(workspace, entry.name);
      if (!benchmarkId || result.definition.id === benchmarkId) results.push(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ runId: entry.name, error: String(error) });
    }
  }
  return { results: results.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), issues };
}

/** Only called after the worker exits, so the supervisor never competes with its writer. */
export async function appendBenchmarkEvent(runDir: string, result: BenchmarkExecution, type: string, data: Record<string, unknown>) {
  const file = join(runDir, "events.jsonl");
  const text = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  // A terminated writer can leave a partial line. Preserve it, but sequence from
  // the last complete event and separate the supervisor record onto its own line.
  let seq = 1;
  for (const line of text.trimEnd().split("\n").reverse()) {
    try {
      const previous = JSON.parse(line).seq;
      if (Number.isSafeInteger(previous)) { seq = previous + 1; break; }
    } catch { /* Incomplete tail remains available for diagnostics. */ }
  }
  const at = new Date().toISOString(), atMs = performance.now(), clockId = `supervisor-${result.runId}`;
  await appendFile(file, (text && !text.endsWith("\n") ? "\n" : "") + JSON.stringify({ schemaVersion: 2, runId: result.runId, seq, at, atMs,
    source: { component: "benchmark", implementation: "supervisor" },
    origin: { eventId: `${clockId}:${seq}`, clockId, seq, at, atMs },
    trace: result.trace, type, data: { benchmarkId: result.definition.id, ...data },
  }) + "\n");
}

export async function recordSupervisorEnd(runDir: string, result: BenchmarkExecution) {
  await appendBenchmarkEvent(runDir, result, "benchmark_supervisor_end", { ...benchmarkEventSummary(result),
    status: result.status, error: result.error, phase: result.errorPhase });
}
