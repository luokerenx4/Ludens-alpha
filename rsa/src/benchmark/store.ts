import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceState } from "../harness/workspace-state.ts";
import { validateResult, type BenchmarkResult } from "./contract.ts";

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
export async function writeResult(runDir: string, result: BenchmarkResult) {
  validateResult(result);
  await atomicJson(join(runDir, "benchmark.json"), result);
}
export async function readResult(workspace: string, runId: string): Promise<BenchmarkResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId) || [".", ".."].includes(runId)) throw new Error("Invalid benchmark run ID");
  const root = await realpath(join(workspace, "logs"));
  const file = join(root, runId, "benchmark.json");
  if (await realpath(file) !== file) throw new Error("Benchmark result must belong to the workspace logs");
  const result: BenchmarkResult = JSON.parse(await readFile(file, "utf8"));
  validateResult(result);
  if (result.runId !== runId || result.workspace !== await realpath(workspace)) throw new Error("Benchmark result identity mismatch");
  return result;
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
export async function recordSupervisorEnd(runDir: string, result: BenchmarkResult) {
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
    trace: result.trace, type: "benchmark_supervisor_end",
    data: { benchmarkId: result.definition.id, status: result.status, error: result.error },
  }) + "\n");
}
