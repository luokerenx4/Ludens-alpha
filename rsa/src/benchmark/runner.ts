import { spawn } from "node:child_process";
import { pythonExecutable } from "../../../shared/python.ts";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import { childTrace, EVENT_SCHEMA_VERSION } from "../harness/events.ts";
import { runProvenance } from "../harness/provenance.ts";
import { reportSchema, validateAuthorReport } from "./report.ts";
import { builtinDefinitions } from "./builtins.ts";
import { discoverBenchmarks, pythonBridge, pythonEnv } from "./catalog.ts";
import { benchmarkEventSummary, compareResults, type BenchmarkDefinition, type BenchmarkExecution, type BenchmarkResult } from "./contract.ts";
import { appendBenchmarkEvent, atomicJson, history, indexWorkspace, readExecution, readResult, recordSupervisorEnd, saveReport, writeResult } from "./store.ts";

export const BENCH_HELP = `rsa bench list
rsa bench help <id>
rsa bench schema
rsa bench validate <report.json>
rsa bench run <id> [--args '<JSON object>'] [--repeat <n>] [--seconds <n>]
rsa bench report <run-id> --file report.json [--reason <text>] [--protocol <version>]
rsa bench history [id]
rsa bench compare <run-id[@report-id]> <run-id[@report-id]>
Uses the current workspace (or rsa --workspace <path> bench ...).
Execution: logs/<run-id>/benchmark.json; immutable reports: logs/<run-id>/reports/.
Run explicitly selects one case, including cases that use an online model. No implicit batch.
Built-ins also accept --model, --requests, --seed (defaults: openai-codex/gpt-6.1-sol, 30, 7).
--seconds defaults to 180: built-in task budget, or Python process budget (+30s cleanup).
Device calls keep normal control/epoch requirements. Conditions describe the test; logs record actual calls.
Run exit codes: 0 valid metrics-only/passed; 1 execution error/cancelled/failed or unknown checks; 2 report missing/invalid.
Report errors do NOT mean the action failed. Correct saved measurements with 'report', without rerunning the function.
Report submissions append a revision; they never change execution status or increase trial count.
Compare pins report IDs in its output; protocol versions identify scoring rules, not subject code versions.

Python: from rsa_tools import benchmark, current_benchmark
@benchmark(protocol="1", targets=["python/vision.py:detect"])
def evaluate(dataset: str) -> dict:
    """Measure detection on a dataset."""
    current_benchmark().conditions(dataset=dataset)
    return {
        "metrics": {"accuracy": {"value": 0.9, "unit": "ratio", "direction": "higher"}},
        "checks": {"usable": {"passed": True, "expected": 0.8, "actual": 0.9}}
    }
checks and metrics are optional maps. Check passed is bool|null; label/expected/actual/evidenceSeq are optional.
Metric value is finite number|null (explicit missing measurement), unit is required, direction defaults to none.
Use context.conditions/subject/artifact/limitations for metadata, not fields in the returned report.
Direct imports run in-process and preserve the original return value; report errors are logged separately.
Definitions/parameters can be validated before execution; dynamic report values are validated after measurement.
Benchmark functions are discovered statically, not registered as controller/OMP tools.`;

export interface RunOptions {
  workspace: string; artifactRoot: string;
  model: string; seconds: number; maxRequests: number; seed: number;
  signal?: AbortSignal;
}
export interface WorkerInput {
  caseId: string; runDir: string; workspace: string; result: BenchmarkExecution;
  model: string; seconds: number; maxRequests: number; seed: number;
}
const runExitCode = (result: BenchmarkResult) => result.status !== "completed" ? 1 :
  !result.report?.outcome ? 2 : result.verdict === null || result.verdict === "passed" ? 0 : 1;

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
  const diagnostics = inherited && process.env.RSA_LOG_DIAGNOSTICS === "full" ? "full" : "normal";
  const parentRunId = inherited ? process.env.RSA_RUN_ID : undefined;
  const trace = childTrace(inherited ? JSON.parse(process.env.BASEWARE_TRACE ?? "{}") : {}) as Record<string, string>;
  const provenance = await runProvenance(executionWorkspace).catch(error => {
    if (error.code === "ENOENT") return {}; throw error;
  });
  const result: BenchmarkExecution = { schemaVersion: 3, definition, status: "running",
    startedAt, endedAt: null, durationMs: null, runId, project: state.id, workspace: state.workspace,
    ...(parentRunId ? { parentRunId } : {}), trace, parameters, provenance,
    conditions: { diagnostics }, subjects: [], artifacts: [], limitations: definition.scope ? [definition.scope] : [] };
  await atomicJson(join(runDir, "manifest.json"), {
    kind: "benchmark", runId, workspace: state.workspace, workspaceId: state.id, stateDir: state.dir,
    eventSchemaVersion: EVENT_SCHEMA_VERSION, drivers: [], model: isolated ? parameters.model : null,
    seconds: budgetSeconds, maxRequests: isolated ? parameters.maxRequests : 0, provenance,
    logging: { diagnostics },
    benchmark: { id: definition.id, revision: definition.revision, protocolVersion: definition.protocolVersion }, parentRunId, trace,
  });
  await writeResult(runDir, result);
  let executable: string, argv: string[], input: string | undefined, env: NodeJS.ProcessEnv;
  if (definition.entry.kind === "builtin") {
    const worker: WorkerInput = { caseId: definition.entry.caseId, runDir, workspace: executionWorkspace, result,
      model: String(parameters.model), seconds: Number(parameters.seconds), maxRequests: Number(parameters.maxRequests), seed: Number(parameters.seed) };
    const inputPath = join(runDir, "benchmark-input.json");
    await atomicJson(inputPath, worker);
    executable = process.execPath; argv = [join(import.meta.dir, "worker.ts"), inputPath];
    env = { ...process.env, RSA_WORKSPACE: executionWorkspace, RSA_ARTIFACT_ROOT: options.artifactRoot, RSA_SOCKET: "", BASEWARE_SOCKET: "",
      RSA_RUN_ID: "", BASEWARE_EPOCH: "", BASEWARE_TRACE: "{}", RSA_LOG_DIAGNOSTICS: diagnostics };
  } else {
    executable = pythonExecutable(); argv = pythonBridge;
    input = JSON.stringify({ action: "invoke_benchmark", workspace: state.workspace, definition, arguments: parameters, runDir, result });
    env = pythonEnv(state.workspace, { RSA_ARTIFACT_ROOT: options.artifactRoot,
      RSA_SOCKET: inherited && process.env.RSA_SOCKET || state.socket,
      RSA_RUN_ID: parentRunId ?? "", BASEWARE_TRACE: JSON.stringify(trace), RSA_LOG_DIAGNOSTICS: diagnostics,
      ...(!inherited ? { BASEWARE_EPOCH: "", BASEWARE_SOCKET: "" } : {}) });
  }
  const output = createWriteStream(join(runDir, "benchmark-worker.log"));
  const child = spawn(executable, argv, { cwd: executionWorkspace, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let reply = "";
  if (definition.entry.kind === "python") child.stdout.on("data", chunk => { reply += chunk; });
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
  const final = await readExecution(state.workspace, runId);
  let bridgeError: { type?: string; message?: string; traceback?: string; phase?: "load" | "execute" } | undefined;
  if (reply.trim()) try { bridgeError = JSON.parse(reply).error; } catch { /* Process/log diagnostics remain available. */ }
  if (final.status === "completed" && (bridgeError || processError || code !== 0)) {
    await appendBenchmarkEvent(runDir, final, "benchmark_report_error", {
      phase: "report", error: bridgeError?.traceback ?? processError ?? `Benchmark worker exited ${code}; see benchmark-worker.log`,
    });
  }
  // The process has exited: the supervisor can now finalize a missing terminal record.
  if (final.status === "running") {
    final.status = interruption?.status ?? "error";
    final.errorPhase = bridgeError?.phase ?? (bridgeError ? "load" : "execute");
    final.error = interruption?.reason ?? processError ?? bridgeError?.traceback ?? (bridgeError ? `${bridgeError.type}: ${bridgeError.message}` : `Benchmark process exited ${code} without a complete result`);
    final.endedAt = new Date().toISOString(); final.durationMs = Date.parse(final.endedAt) - Date.parse(final.startedAt);
    await writeResult(runDir, final);
    await recordSupervisorEnd(runDir, final).catch(error => {
      console.error(`Benchmark result saved; supervisor event could not be written: ${error}`);
    });
  }
  return { runDir, result: await readResult(state.workspace, runId) };
}
export async function runCase(id: string, options: RunOptions) {
  const definition = builtinDefinitions.find(item => item.id === id);
  if (!definition) throw new Error(`Unknown built-in benchmark: ${id}`);
  return runBenchmark(definition, {}, options);
}

export async function benchmarkCommand(args: string[], artifactRoot: string, workspace = process.cwd()) {
  if (!args.length || args.includes("--help")) { console.log(BENCH_HELP); return; }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (args[0] === "schema" && args.length === 1) { print(reportSchema); return; }
  if (args[0] === "validate" && args.length === 2) {
    const validation = validateAuthorReport(JSON.parse(await readFile(resolve(workspace, args[1]!), "utf8")));
    print(validation); if (validation.errors.length) process.exitCode = 2; return;
  }
  if (args[0] === "report" && args[1]) {
    const { values } = parseArgs({ args: args.slice(2), options: { file: { type: "string" }, reason: { type: "string", default: "correction" }, protocol: { type: "string" } } });
    if (!values.file) throw new Error("Use rsa bench report <run-id> --file report.json");
    const execution = await readExecution(workspace, args[1]);
    const runDir = join(execution.workspace, "logs", execution.runId);
    const report = await saveReport(runDir, execution, JSON.parse(await readFile(resolve(workspace, values.file), "utf8")),
      { reason: values.reason, protocolVersion: values.protocol });
    await appendBenchmarkEvent(runDir, execution, "benchmark_report", { ...benchmarkEventSummary(execution, report),
      protocolVersion: report.protocolVersion, valid: !report.errors.length, errors: report.errors, reason: report.reason });
    print(await readResult(workspace, execution.runId, report.id));
    if (report.errors.length) process.exitCode = 2; return;
  }
  if (args[0] === "history" && args.length <= 2) { print(await history(workspace, args[1])); return; }
  if (args[0] === "compare" && args.length === 3) {
    const readSelection = (selection: string) => {
      const [runId, reportId, extra] = selection.split("@");
      if (!runId || extra !== undefined || reportId === "") throw new Error("Use run-id or run-id@report-id");
      return readResult(workspace, runId, reportId);
    };
    const [a, b] = await Promise.all([readSelection(args[1]!), readSelection(args[2]!)]);
    print(compareResults(a, b)); return;
  }
  const catalog = await discoverBenchmarks(workspace, artifactRoot);
  if (args[0] === "list" && args.length === 1) { print(catalog); return; }
  const selected = catalog.benchmarks.filter(item => item.id === args[1]);
  if (args[0] === "help" && args.length === 2 && selected.length === 1) { print({ ...selected[0], reportSchema }); return; }
  if (args[0] !== "run" || !selected.length) throw new Error(`Unknown benchmark/command. Use rsa bench list or --help.`);
  const { values } = parseArgs({ args: args.slice(2), options: {
    repeat: { type: "string", default: "1" }, seed: { type: "string", default: "7" },
    seconds: { type: "string", default: "180" }, requests: { type: "string", default: "30" },
    model: { type: "string", default: "openai-codex/gpt-6.1-sol" }, args: { type: "string", default: "{}" },
  } });
  const positiveInteger = (name: string, value: string) => {
    const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`); return number;
  };
  const repeat = positiveInteger("repeat", values.repeat!);
  const options: RunOptions = { workspace, artifactRoot, model: values.model!, seed: Number(values.seed),
    seconds: positiveInteger("seconds", values.seconds!), maxRequests: positiveInteger("requests", values.requests!) };
  if (!Number.isSafeInteger(options.seed)) throw new Error("--seed must be an integer");
  const parameters = JSON.parse(values.args!);
  if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") throw new Error("--args must be a JSON object");
  for (let n = 0; n < repeat; n++) for (const definition of selected) {
    const { result } = await runBenchmark(definition, parameters, options);
    print(result);
    const code = runExitCode(result);
    if (code) process.exitCode = code;
    if (result.status === "cancelled") return;
  }
}
