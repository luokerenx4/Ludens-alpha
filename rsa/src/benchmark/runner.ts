import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import { childTrace, EventLog, EVENT_SCHEMA_VERSION } from "../harness/events.ts";
import { runProvenance } from "../harness/provenance.ts";
import { builtinDefinitions } from "./builtins.ts";
import { discoverBenchmarks, pythonBridge, pythonEnv } from "./catalog.ts";
import { compareResults, type BenchmarkDefinition, type BenchmarkResult } from "./contract.ts";
import { atomicJson, history, indexWorkspace, readResult, recordSupervisorEnd, writeResult } from "./store.ts";

export const BENCH_HELP = `rsa bench list
rsa bench help <id>
rsa bench run <id|all> [--args '<JSON object>'] [--repeat <n>] [--live] [--seconds <n>]
rsa bench history [id]
rsa bench compare <run-id-a> <run-id-b>
Uses the current workspace (or rsa --workspace <path> bench ...).
Results: <workspace>/logs/<run-id>/{manifest.json,events.jsonl,benchmark.json}.
'all' selects built-in Harness cases only; --live explicitly enables online cases.
Built-ins also accept --model, --requests, --seed (defaults: openai-codex/gpt-6.1-sol, 30, 7).
--seconds defaults to 180: built-in task budget, or Python process budget (+30s cleanup).
Workspace functions run explicitly; device calls keep normal control/epoch requirements.
Exit 0 means completed without failed/unknown checks, or skipped; no checks means metrics-only.

Python: from rsa_tools import benchmark, current_benchmark
@benchmark(targets=["python/vision.py:detect"])
def evaluate(dataset: str) -> dict:
    """Measure detection on a dataset."""
    return {"metrics": [{"id": "accuracy", "value": 0.9, "unit": "ratio", "direction": "higher"}]}
checks are optional: {id,label,passed: true|false|null,expected,actual,evidenceSeq: []}.
Use current_benchmark() to register conditions, subjects and artifacts; direct imports run in-process.
Benchmark functions are discovered statically, not registered as controller/OMP tools.`;

export interface RunOptions {
  workspace: string; artifactRoot: string; live: boolean;
  model: string; seconds: number; maxRequests: number; seed: number;
  signal?: AbortSignal;
}
export interface WorkerInput {
  caseId: string; runDir: string; workspace: string; result: BenchmarkResult;
  model: string; seconds: number; maxRequests: number; seed: number;
}
const successful = (result: BenchmarkResult) => result.status === "skipped" ||
  result.status === "completed" && (result.verdict === null || result.verdict === "passed");

/** One record per evaluation; only built-in fault fixtures get a scratch workspace. */
export async function runBenchmark(definition: BenchmarkDefinition, args: Record<string, unknown>, options: RunOptions) {
  options.signal?.throwIfAborted();
  const state = await indexWorkspace(options.workspace, options.artifactRoot);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(state.workspace, "logs", runId);
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const isolated = definition.entry.kind === "builtin";
  const executionWorkspace = isolated ? join(runDir, "work") : state.workspace;
  if (isolated) {
    await Promise.all([mkdir(join(executionWorkspace, "skills"), { recursive: true }), mkdir(join(executionWorkspace, "memory"), { recursive: true })]);
    await writeFile(join(executionWorkspace, "AGENTS.md"), workspaceGuide);
  }
  const parameters = isolated ? { model: options.model, seconds: options.seconds, maxRequests: options.maxRequests, seed: options.seed, ...args } : args;
  if (isolated) {
    if (Object.keys(parameters).some(key => !["model", "seconds", "maxRequests", "seed"].includes(key))) throw new Error("Unknown built-in benchmark parameter");
    if (typeof parameters.model !== "string" || !Number.isSafeInteger(parameters.seed)) throw new Error("Invalid model/seed");
    for (const key of ["seconds", "maxRequests"]) if (!Number.isSafeInteger(parameters[key]) || Number(parameters[key]) < 1) throw new Error(`${key} must be a positive integer`);
  }
  const budgetSeconds = Number(isolated ? parameters.seconds : options.seconds);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0 || (budgetSeconds + 30) * 1000 > 2147483647) throw new Error("Invalid benchmark process budget");
  const inherited = !process.env.RSA_WORKSPACE || resolve(process.env.RSA_WORKSPACE) === state.workspace;
  const parentRunId = inherited ? process.env.RSA_RUN_ID : undefined;
  const trace = childTrace(inherited ? JSON.parse(process.env.BASEWARE_TRACE ?? "{}") : {}) as Record<string, string>;
  const provenance = await runProvenance(executionWorkspace).catch(error => {
    if (error.code === "ENOENT") return {}; throw error;
  });
  const result: BenchmarkResult = { schemaVersion: 2, definition, status: "running", verdict: null,
    startedAt, endedAt: null, durationMs: null, runId, project: state.id, workspace: state.workspace,
    ...(parentRunId ? { parentRunId } : {}), trace, parameters, provenance,
    checks: [], metrics: [], conditions: {}, subjects: [], artifacts: [], limitations: definition.scope ? [definition.scope] : [] };
  await atomicJson(join(runDir, "manifest.json"), {
    kind: "benchmark", runId, workspace: state.workspace, workspaceId: state.id, stateDir: state.dir,
    eventSchemaVersion: EVENT_SCHEMA_VERSION, drivers: [], model: isolated ? parameters.model : null,
    seconds: budgetSeconds, maxRequests: isolated ? parameters.maxRequests : 0, provenance,
    benchmark: { id: definition.id, revision: definition.revision, mode: definition.mode }, parentRunId, trace,
  });
  await writeResult(runDir, result);
  if (definition.mode === "live" && !options.live) {
    result.status = "skipped"; result.endedAt = new Date().toISOString(); result.durationMs = 0;
    result.limitations!.push("Requires --live; no online request was made.");
    const log = new EventLog(runDir, { id: runId, now: () => performance.now() });
    log.recorder({ component: "benchmark" })("benchmark_skipped", { benchmarkId: definition.id, reason: "--live required" }, trace);
    await writeResult(runDir, result);
    return { runDir, result };
  }
  let executable: string, argv: string[], input: string | undefined, env: NodeJS.ProcessEnv;
  if (definition.entry.kind === "builtin") {
    const worker: WorkerInput = { caseId: definition.entry.caseId, runDir, workspace: executionWorkspace, result,
      model: String(parameters.model), seconds: Number(parameters.seconds), maxRequests: Number(parameters.maxRequests), seed: Number(parameters.seed) };
    const inputPath = join(runDir, "benchmark-input.json");
    await atomicJson(inputPath, worker);
    executable = process.execPath; argv = [join(import.meta.dir, "worker.ts"), inputPath];
    env = { ...process.env, RSA_WORKSPACE: executionWorkspace, RSA_ARTIFACT_ROOT: options.artifactRoot, RSA_SOCKET: "", BASEWARE_SOCKET: "",
      RSA_RUN_ID: "", BASEWARE_EPOCH: "", BASEWARE_TRACE: "{}" };
  } else {
    executable = process.env.RSA_PYTHON ?? "python3"; argv = ["-B", pythonBridge];
    input = JSON.stringify({ action: "invoke_benchmark", workspace: state.workspace, definition, arguments: parameters, runDir, result });
    env = pythonEnv(state.workspace, { RSA_ARTIFACT_ROOT: options.artifactRoot,
      RSA_SOCKET: inherited && process.env.RSA_SOCKET || state.socket,
      RSA_RUN_ID: parentRunId ?? "", BASEWARE_TRACE: JSON.stringify(trace),
      ...(!inherited ? { BASEWARE_EPOCH: "", BASEWARE_SOCKET: "" } : {}) });
  }
  const output = createWriteStream(join(runDir, "benchmark-worker.log"));
  const child = spawn(executable, argv, { cwd: executionWorkspace, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let interruption: { status: "error" | "cancelled"; reason: string } | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (status: "error" | "cancelled", reason: string) => {
    if (interruption) return;
    interruption = { status, reason }; kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 5000);
  };
  let processError: string | undefined;
  output.on("error", error => { processError = String(error); stop("error", `Benchmark log write failed: ${error}`); });
  const onSignal = () => stop("cancelled", "Benchmark runner interrupted");
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  options.signal?.addEventListener("abort", onSignal, { once: true });
  const timeout = setTimeout(() => stop("error", `Benchmark exceeded ${budgetSeconds + 30}s process budget`), (budgetSeconds + 30) * 1000);
  child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") processError = String(error); });
  const code = await new Promise<number | null>(done => {
    child.once("error", error => { processError = String(error); });
    child.once("close", done);
    child.stdin.end(input);
    if (options.signal?.aborted) onSignal();
  });
  clearTimeout(timeout); if (force) clearTimeout(force);
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  options.signal?.removeEventListener("abort", onSignal);
  if (!output.destroyed) await new Promise<void>(done => { output.once("error", () => done()); output.end(done); });
  const final = await readResult(state.workspace, runId);
  // The process has exited: the supervisor can now finalize a missing terminal record.
  if (interruption || processError || final.status === "running" || (code !== 0 && final.status === "completed")) {
    final.status = interruption?.status ?? "error"; final.verdict = null;
    final.error = interruption?.reason ?? processError ?? `Benchmark process exited ${code} without a complete result`;
    final.endedAt = new Date().toISOString(); final.durationMs = Date.parse(final.endedAt) - Date.parse(final.startedAt);
    await writeResult(runDir, final);
    await recordSupervisorEnd(runDir, final).catch(error => {
      console.error(`Benchmark result saved; supervisor event could not be written: ${error}`);
    });
  }
  return { runDir, result: final };
}
export async function runCase(id: string, options: RunOptions) {
  const definition = builtinDefinitions.find(item => item.id === id);
  if (!definition) throw new Error(`Unknown built-in benchmark: ${id}`);
  return runBenchmark(definition, {}, options);
}

export async function benchmarkCommand(args: string[], artifactRoot: string, workspace = process.cwd()) {
  if (!args.length || args.includes("--help")) { console.log(BENCH_HELP); return; }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (args[0] === "history" && args.length <= 2) { print(await history(workspace, args[1])); return; }
  if (args[0] === "compare" && args.length === 3) {
    const [a, b] = await Promise.all([readResult(workspace, args[1]!), readResult(workspace, args[2]!)]);
    print(compareResults(a, b)); return;
  }
  const catalog = await discoverBenchmarks(workspace, artifactRoot);
  if (args[0] === "list" && args.length === 1) { print(catalog); return; }
  const selected = args[1] === "all" ? catalog.benchmarks.filter(item => item.source === "builtin") : catalog.benchmarks.filter(item => item.id === args[1]);
  if (args[0] === "help" && args.length === 2 && selected.length === 1) { print(selected[0]); return; }
  if (args[0] !== "run" || !selected.length) throw new Error(`Unknown benchmark/command. Use rsa bench list or --help.`);
  const { values } = parseArgs({ args: args.slice(2), options: {
    live: { type: "boolean", default: false }, repeat: { type: "string", default: "1" }, seed: { type: "string", default: "7" },
    seconds: { type: "string", default: "180" }, requests: { type: "string", default: "30" },
    model: { type: "string", default: "openai-codex/gpt-6.1-sol" }, args: { type: "string", default: "{}" },
  } });
  const positiveInteger = (name: string, value: string) => {
    const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`); return number;
  };
  const repeat = positiveInteger("repeat", values.repeat!);
  const options: RunOptions = { workspace, artifactRoot, model: values.model!, live: values.live!, seed: Number(values.seed),
    seconds: positiveInteger("seconds", values.seconds!), maxRequests: positiveInteger("requests", values.requests!) };
  if (!Number.isSafeInteger(options.seed)) throw new Error("--seed must be an integer");
  const parameters = JSON.parse(values.args!);
  if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") throw new Error("--args must be a JSON object");
  for (let n = 0; n < repeat; n++) for (const definition of selected) {
    const { result } = await runBenchmark(definition, parameters, options);
    print(result);
    if (!successful(result)) process.exitCode = 1;
    if (result.status === "cancelled") return;
  }
}
