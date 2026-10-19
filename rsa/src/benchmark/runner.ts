import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import catalog from "../../benchmarks/cases.json";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import { EventLog, EVENT_SCHEMA_VERSION } from "../harness/events.ts";
import { runProvenance } from "../harness/provenance.ts";
import { resolveWorkspaceState } from "../harness/workspace-state.ts";
import type { BenchmarkResult, CaseOutcome } from "./types.ts";

export const BENCH_HELP = `rsa bench list
rsa bench run <case|all> [--live] [--repeat <n>] [--seed <n>] [--seconds <n>] [--requests <n>] [--model <provider/model>] [--output <directory>]
Each case gets a new isolated workspace and process; no running game is touched.
Offline cases inject faults into real Harness paths. capability-reuse requires --live and uses a real model.
Defaults: 180 seconds, 30 requests, seed 7, openai-codex/gpt-6.1-sol.
Results and original events live in <output>/<case-run>/workspace/logs/<run-id>/.
Exit status: 0 passed/skipped, 1 failed/inconclusive/error. Skipped cases were not tested.`;

export interface RunOptions {
  model: string; seconds: number; maxRequests: number; seed: number; live: boolean;
  output: string; artifactRoot: string;
}
export interface WorkerInput {
  caseId: string; runDir: string; workspace: string; result: BenchmarkResult;
  model: string; seconds: number; maxRequests: number; seed: number;
}
export function outcomeStatus(outcome: CaseOutcome): BenchmarkResult["status"] {
  if (outcome.checks.some(check => check.passed === false)) return "failed";
  if (!outcome.checks.length || outcome.checks.some(check => check.passed === null)) return "inconclusive";
  return "passed";
}
export async function writeResult(runDir: string, result: BenchmarkResult) {
  const file = join(runDir, "benchmark.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(result, null, 2) + "\n");
  await rename(temporary, file);
}

export async function runCase(caseId: string, options: RunOptions) {
  const definition = catalog.find(item => item.id === caseId);
  if (!definition) throw new Error(`Unknown benchmark: ${caseId}`);
  const startedAt = new Date().toISOString();
  const runId = startedAt.replaceAll(":", "-");
  const directory = join(options.output, `${runId}-${caseId}-${randomUUID().slice(0, 8)}`);
  const workspace = join(directory, "workspace");
  const state = await resolveWorkspaceState(workspace, options.artifactRoot);
  const runDir = join(workspace, "logs", runId);
  await Promise.all([mkdir(join(workspace, "skills")), mkdir(join(workspace, "memory")), mkdir(runDir, { recursive: true })]);
  await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" });
  await writeFile(join(state.dir, "workspace.json"), JSON.stringify({ workspace }, null, 2));
  const provenance = await runProvenance(workspace);
  const mode = definition.mode as "offline" | "live";
  const result: BenchmarkResult = {
    schemaVersion: 1, caseId, caseVersion: definition.version, title: definition.title, mode,
    status: "running", startedAt, endedAt: null, durationMs: null, runId, project: state.id,
    parameters: { model: mode === "live" ? options.model : null, seconds: options.seconds, maxRequests: options.maxRequests, seed: options.seed },
    provenance, checks: [], metrics: [], limitations: [definition.scope],
  };
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({
    runId, workspace, workspaceId: state.id, stateDir: state.dir, socket: state.socket,
    eventSchemaVersion: EVENT_SCHEMA_VERSION, drivers: [],
    model: result.parameters.model, seconds: options.seconds, maxRequests: options.maxRequests,
    compactionThreshold: 256000, shiori: { implementation: "omp", implementationVersion: "18.9.1" },
    provenance, benchmark: { caseId, caseVersion: definition.version, mode },
  }, null, 2));
  await writeResult(runDir, result);
  const input: WorkerInput = { caseId, runDir, workspace, result, model: options.model,
    seconds: options.seconds, maxRequests: options.maxRequests, seed: options.seed };
  const inputPath = join(runDir, "benchmark-input.json");
  await writeFile(inputPath, JSON.stringify(input, null, 2));
  if (mode === "live" && !options.live) {
    result.status = "skipped";
    result.endedAt = new Date().toISOString();
    result.durationMs = 0;
    result.limitations!.push("未启用 --live；没有请求模型，也没有执行此 case。");
    const log = new EventLog(runDir, { id: runId, now: () => performance.now() });
    log.recorder({ component: "benchmark" })("benchmark_skipped", { caseId, reason: "--live is required" });
    await writeResult(runDir, result);
    return { runDir, result };
  }

  // Separate process: fault cases can own fetch/WebSocket/clock globals without
  // leaking into another case or an existing game Host. Kill its group on timeout.
  const outputFile = Bun.file(join(runDir, "benchmark-worker.log")).writer();
  const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts"), inputPath], {
    cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RSA_WORKSPACE: workspace, RSA_SOCKET: state.socket, BASEWARE_SOCKET: "" },
  });
  child.stdout.on("data", data => outputFile.write(data));
  child.stderr.on("data", data => outputFile.write(data));
  let interruption: string | undefined;
  const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => {
    interruption = reason;
    kill("SIGTERM");
    force ??= setTimeout(() => kill("SIGKILL"), 5000);
  };
  const onSignal = () => stop("Benchmark runner interrupted");
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  const timeout = setTimeout(() => stop(`Case exceeded ${options.seconds + 30}s process budget`), (options.seconds + 30) * 1000);
  let processError: string | undefined;
  const code = await new Promise<number | null>(done => {
    child.once("error", error => { processError = String(error); done(null); });
    child.once("close", done);
  });
  clearTimeout(timeout); if (force) clearTimeout(force);
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  await outputFile.end();
  const final: BenchmarkResult = JSON.parse(await readFile(join(runDir, "benchmark.json"), "utf8"));
  if (final.status === "running" || interruption || processError || (code !== 0 && final.status === "passed")) {
    final.status = "error";
    final.error = interruption ?? processError ?? `Benchmark process exited with code ${code} before producing a complete result`;
    final.endedAt = new Date().toISOString();
    final.durationMs = Date.parse(final.endedAt) - Date.parse(final.startedAt);
    await writeResult(runDir, final);
  }
  return { runDir, result: final };
}

export async function benchmarkCommand(args: string[], artifactRoot: string) {
  if (!args.length || args.includes("--help")) { console.log(BENCH_HELP); return; }
  if (args[0] === "list" && args.length === 1) {
    for (const item of catalog) console.log(`${item.id}\t${item.mode}\tv${item.version}\t${item.title}\n  ${item.description}`);
    return;
  }
  if (args[0] !== "run" || !args[1]) throw new Error(BENCH_HELP);
  const selected = args[1] === "all" ? catalog : catalog.filter(item => item.id === args[1]);
  if (!selected.length) throw new Error(`Unknown benchmark: ${args[1]}. Use rsa bench list.`);
  const { values } = parseArgs({ args: args.slice(2), options: {
    live: { type: "boolean", default: false }, repeat: { type: "string", default: "1" }, seed: { type: "string", default: "7" },
    seconds: { type: "string", default: "180" }, requests: { type: "string", default: "30" },
    model: { type: "string", default: "openai-codex/gpt-6.1-sol" }, output: { type: "string" },
  } });
  const positiveInteger = (name: string, value: string) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`);
    return number;
  };
  const repeat = positiveInteger("repeat", values.repeat!);
  const seconds = positiveInteger("seconds", values.seconds!);
  if ((seconds + 30) * 1000 > 2147483647) throw new Error("--seconds exceeds the process timer range");
  const maxRequests = positiveInteger("requests", values.requests!);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  const options: RunOptions = { model: values.model!, seconds, maxRequests, seed, live: values.live!,
    output: resolve(values.output ?? join(artifactRoot, "benchmarks")), artifactRoot };
  for (let n = 0; n < repeat; n++) for (const item of selected) {
    console.log(`Running ${item.id} (${n + 1}/${repeat})${item.mode === "live" && !options.live ? " — skipped without --live" : ""}`);
    const { result, runDir } = await runCase(item.id, options);
    console.log(`${result.status}: ${item.title} — ${join(runDir, "benchmark.json")}`);
    if (!["passed", "skipped"].includes(result.status)) process.exitCode = 1;
    if (result.error === "Benchmark runner interrupted") return;
  }
}
