/** Shiori's benchmark entry: Task contracts supply inputs, the existing Runtime owns every execution. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { pythonEnvironment, pythonExecutable } from "../../../shared/python.ts";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import { Runtime as Shiori } from "./runtime.ts";
import { runProvenance } from "./provenance.ts";
import { EventLog, EVENT_SCHEMA_VERSION } from "./events.ts";
import { resolveTask } from "../benchmark/catalog.ts";
import { hashFile, pinTask, readTask } from "../benchmark/task.ts";
import { benchmarkEventSummary, isObject, validateRewards, type Trial, type EvidenceReference, type TaskDefinition, type Verification } from "../benchmark/contract.ts";
import { atomicJson, createTrial, finishTrial, createVerification, finishVerification, get, readTrial, indexWorkspace, inspectEvidence } from "../benchmark/store.ts";

const rsa = resolve(import.meta.dir, "../..");
const exec = promisify(execFile);
async function sourceTreeHash() {
  const root = resolve(rsa, "..");
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "rsa/src", "rsa/python/rsa_tools", "rsa/scripts", "rsa/templates", "rsa/prompts", "baseware/src", "baseware/python", "shared",
    "rsa-dashboard/lib", "rsa-dashboard/worker", "rsa-dashboard/scripts", "rsa/package.json", "rsa/bun.lock", "rsa/python/uv.lock"], { cwd: root });
  const hash = createHash("sha256");
  for (const file of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    const path = join(root, file);
    if ((await stat(path).catch(() => undefined))?.isFile()) hash.update(`${file}\0${await hashFile(path)}\n`);
  }
  return hash.digest("hex");
}
const identity = (task: TaskDefinition) => ({ name: task.name, digest: task.digest, ...(task.version ? { version: task.version } : {}) });
const errorInfo = (code: string, error: unknown) => ({ code, message: error instanceof Error ? error.message : String(error) });
export interface RunConfiguration {
  task: string; argv: string[]; cwd?: string; workspace?: "current" | "isolated";
  seconds?: number; parameters?: Record<string, unknown>; onlineModel?: boolean;
}
export interface RunOptions {
  workspace: string; artifactRoot: string; config?: RunConfiguration; configPath?: string;
  seconds?: number; parameters?: Record<string, unknown>; digest?: string; signal?: AbortSignal; verify?: boolean;
}
export async function readRunConfiguration(name: string, file?: string): Promise<RunConfiguration> {
  const path = file ? resolve(file) : join(rsa, "benchmarks", "runs", `${name.replace(/^ludens\//, "")}.json`);
  if (!file && (!name.startsWith("ludens/") || name.slice(7).includes("/"))) throw new Error("Custom tasks require --config with a program binding");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(value) || value.task !== name || !Array.isArray(value.argv) || !value.argv.length || value.argv.some(v => typeof v !== "string" || !v)
      || value.workspace !== undefined && !["current", "isolated"].includes(value.workspace as string)
      || value.parameters !== undefined && !isObject(value.parameters)
      || value.onlineModel !== undefined && typeof value.onlineModel !== "boolean"
      || Object.keys(value).some(key => !["task", "argv", "cwd", "workspace", "seconds", "parameters", "onlineModel"].includes(key))) throw new Error("Invalid native Shiori run configuration");
  return value as unknown as RunConfiguration;
}
function budget(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0 || result * 1000 > 2_147_483_647) throw new Error("Invalid Shiori budget");
  return result;
}
function checkNative(task: TaskDefinition) {
  if (task.unsupportedRequirements.length) throw new Error(`Unsupported native Task requirements: ${task.unsupportedRequirements.join(", ")}`);
}
/** Native profile, not an OS sandbox. Never implicitly grant a live control token or model credentials. */
export function benchmarkEnvironment(onlineModel = false): NodeJS.ProcessEnv {
  const env = pythonEnvironment();
  for (const key of Object.keys(env)) {
    if (/^(RSA_|BASEWARE_)/.test(key) || !onlineModel && /(?:TOKEN|SECRET|API_KEY|PASSWORD|AUTHORIZATION|CREDENTIAL)/i.test(key)) delete env[key];
  }
  env.PATH = [resolve(process.execPath, ".."), env.PATH ?? ""].join(":");
  return env;
}
function declaredEnv(task: TaskDefinition, section: "environment" | "verifier") {
  const env = task.config[section]?.env as Record<string, string> | undefined ?? {};
  if (Object.keys(env).some(key => /^(RSA_|BASEWARE_)/.test(key))) throw new Error("Task env cannot grant or override Shiori identity/control fields");
  if (Object.values(env).some(value => /\$\{/.test(value))) throw new Error("Native Task env does not interpolate shell templates; supply explicit values");
  return env;
}
function render(value: string, variables: Record<string, unknown>) {
  return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, key: string) => {
    const replacement = variables[key];
    if (!["string", "number", "boolean"].includes(typeof replacement)) throw new Error(`Unbound program argument: ${key}`);
    return String(replacement);
  });
}
async function smallJson(path: string) {
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error(`Metadata too large: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}
async function sealFacts(runDir: string, workspace: string, executionWorkspace: string, signal?: AbortSignal) {
  const evidence: EvidenceReference[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(join(runDir, directory), { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) throw new Error("Trial artifacts must not contain symlinks");
      const relative = `${directory}/${entry.name}`, path = join(runDir, relative);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) evidence.push({ kind: "file", path: relative, sizeBytes: (await stat(path)).size, sha256: await hashFile(path) });
    }
  }
  await walk("artifacts");
  const context = await smallJson(join(runDir, "artifacts/context.json")).catch(error => { if (error.code === "ENOENT") return { trialId: basename(runDir) }; throw error; });
  if (!isObject(context)) throw new Error("Program context must be an object of facts");
  if (context.trialId !== basename(runDir) || context.workspace !== undefined && context.workspace !== executionWorkspace) throw new Error("Program fact identity does not match this Shiori trial/workspace");
  for (const artifact of Array.isArray(context.artifacts) ? context.artifacts : []) {
    if (isObject(artifact) && isObject(artifact.timeline)) evidence.push({ kind: "timeline", timeline: artifact.timeline as any, workspaceRelative: relative(workspace, executionWorkspace) || ".",
      ...(typeof artifact.sha256 === "string" ? { sha256: artifact.sha256 } : {}), label: typeof artifact.label === "string" ? artifact.label : undefined });
  }
  // The existing archive is authoritative. Freeze a prefix, never duplicate the run log.
  const events = join(runDir, "events.jsonl");
  const bytes = (await stat(events)).size;
  evidence.push({ kind: "event", runId: basename(runDir), path: "events.jsonl", byteLength: bytes, sha256: await hashFile(events, bytes) });
  for (const reference of evidence) {
    signal?.throwIfAborted();
    const inspected = await inspectEvidence(workspace, basename(runDir), reference, { signal });
    if (!inspected.available) throw new Error(inspected.error?.message ?? "Unavailable program evidence");
    if (reference.kind === "timeline" && inspected.path) reference.sha256 = await hashFile(inspected.path);
  }
  signal?.throwIfAborted();
  return { evidence, context };
}
function signals(signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Shiori interrupted"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    dispose() { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); } };
}

export async function runTask(name: string, options: RunOptions) {
  const task = await resolveTask(options.workspace, name, options.digest);
  checkNative(task);
  const environment = declaredEnv(task, "environment");
  const configuration = options.config ?? await readRunConfiguration(name, options.configPath);
  if (configuration.task !== name) throw new Error("Run configuration names another Task");
  const parameters = { ...configuration.parameters, ...options.parameters };
  const seconds = budget(options.seconds ?? configuration.seconds ?? task.config.agent?.timeout_sec, 180);
  const state = await indexWorkspace(options.workspace, options.artifactRoot);
  const pinned = await pinTask(state.workspace, task);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(state.workspace, "logs", runId), artifacts = join(runDir, "artifacts");
  const executionWorkspace = configuration.workspace === "isolated" ? join(runDir, "work") : state.workspace;
  await mkdir(artifacts, { recursive: true });
  if (executionWorkspace !== state.workspace) {
    await Promise.all([mkdir(join(executionWorkspace, "skills"), { recursive: true }), mkdir(join(executionWorkspace, "memory"), { recursive: true })]);
    await writeFile(join(executionWorkspace, "AGENTS.md"), workspaceGuide);
  }
  const variables = { rsa, bun: process.execPath, python: pythonExecutable(), workspace: executionWorkspace,
    artifacts, task: pinned.path, ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [`param.${key}`, value])) };
  const argv = configuration.argv.map(value => render(value, variables));
  const cwd = configuration.cwd ? resolve(render(configuration.cwd, variables)) : executionWorkspace;
  const configurationHash = createHash("sha256").update(JSON.stringify({ configuration, parameters })).digest("hex");
  const trial: Trial = { schemaVersion: 1, id: runId, runId, task: identity(task), workspace: state.workspace, project: state.id,
    status: "running", startedAt: new Date().toISOString(), parameters,
    conditions: { profile: "native", os: process.platform, arch: process.arch, configurationHash, seconds,
      onlineModel: configuration.onlineModel === true }, subjects: [], evidence: [] };
  const executorFiles = [...new Set(argv.filter(value => !value.startsWith("-")).map(value => resolve(cwd, value)))];
  for (const path of executorFiles) if ((await stat(path).catch(() => undefined))?.isFile()) trial.subjects.push({ id: "executor", path, sha256: await hashFile(path) });
  if (configuration.onlineModel && typeof parameters.model === "string") trial.subjects.push({ id: "agent/model", revision: parameters.model });
  const provenance = { ...await runProvenance(executionWorkspace), sourceTreeSHA256: await sourceTreeHash() };
  trial.subjects.push({ id: "ludens/source", sha256: provenance.sourceTreeSHA256 });
  const log = new EventLog(runDir, { id: runId, now: () => performance.now() }, state.workspace);
  await atomicJson(join(runDir, "manifest.json"), { kind: "benchmark", runId, workspace: state.workspace, workspaceId: state.id,
    stateDir: state.dir, benchmark: identity(task), drivers: [], seconds, model: configuration.onlineModel ? parameters.model ?? null : null,
    shiori: { implementation: "program" }, provenance, eventSchemaVersion: EVENT_SCHEMA_VERSION });
  await createTrial(state.workspace, trial);
  log.record("benchmark_start", benchmarkEventSummary(trial));
  const input = join(runDir, "input.json");
  await atomicJson(input, { trialId: runId, task: identity(task), parameters, budgetSeconds: seconds, argv, cwd });
  const env = { ...benchmarkEnvironment(configuration.onlineModel), ...environment,
    RSA_WORKSPACE: executionWorkspace, RSA_BENCH_WORKSPACE: state.workspace, RSA_BENCH_TRIAL_ID: runId,
    RSA_BENCH_RUN_DIR: runDir, RSA_BENCH_ARTIFACTS: artifacts, RSA_BENCH_TASK_DIR: pinned.path, RSA_BENCH_INPUT: input };
  const runtime = new Shiori(undefined, log.record, seconds, runId), cancellation = signals(options.signal);
  const started = performance.now();
  try {
    let failure: Trial["error"], status: Trial["status"] = "completed", facts: Awaited<ReturnType<typeof sealFacts>> | undefined;
    try {
      await runtime.runProgram({ argv, cwd, env, stdout: join(runDir, "stdout.log"), stderr: join(runDir, "stderr.log"),
        events: argv[1] === join(rsa, "src/harness/module-program.ts") }, cancellation.signal);
    } catch (error) { status = cancellation.signal.aborted ? "cancelled" : "error"; failure = errorInfo("EXECUTION_ERROR", error); }
    finally {
      await runtime.close();
    }
    try { facts = await sealFacts(runDir, state.workspace, executionWorkspace, cancellation.signal); }
    catch (error) { status = cancellation.signal.aborted ? "cancelled" : "error"; failure ??= errorInfo("EVIDENCE_ERROR", error); }
    if (cancellation.signal.aborted) { status = "cancelled"; failure ??= errorInfo("CANCELLED", cancellation.signal.reason); }
    const terminal = await finishTrial(state.workspace, runId, { status, endedAt: new Date().toISOString(), durationMs: performance.now() - started,
      error: failure, evidence: facts?.evidence ?? [], conditions: { ...trial.conditions, program: isObject(facts?.context.conditions) ? facts.context.conditions : {} },
      subjects: [...trial.subjects, ...(Array.isArray(facts?.context.subjects) ? facts.context.subjects as Trial["subjects"] : [])],
      limitations: Array.isArray(facts?.context.limitations) ? facts.context.limitations as string[] : [] });
    if (terminal.changed) log.record("benchmark_end", benchmarkEventSummary(terminal.trial));
    if (status === "completed" && options.verify !== false && !cancellation.signal.aborted) await verifyTask(state.workspace, runId, { signal: cancellation.signal, log });
    return await get(state.workspace, runId);
  } finally { cancellation.dispose(); }
}

export async function verifyTask(workspace: string, runId: string, options: { taskPath?: string; reason?: string; signal?: AbortSignal; log?: EventLog } = {}) {
  const trial = await readTrial(workspace, runId), runDir = join(trial.workspace, "logs", runId);
  if (trial.status === "running") throw new Error("Trial is still running");
  const original = join(trial.workspace, ".rsa/benchmarks/tasks", trial.task.digest.slice(7));
  const task = await readTask(options.taskPath ?? original);
  if (task.name !== trial.task.name || !options.taskPath && task.digest !== trial.task.digest) throw new Error("Verifier task identity mismatch");
  checkNative(task);
  const pinned = await pinTask(trial.workspace, task);
  const seconds = budget(task.config.verifier?.timeout_sec, 600);
  const verifierEnv = declaredEnv(task, "verifier");
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const verification: Verification = { schemaVersion: 1, id, trialId: runId, task: identity(task), status: "running",
    startedAt: new Date().toISOString(), reason: options.reason ?? "verify", evidence: trial.evidence };
  const { directory } = await createVerification(trial.workspace, runId, verification);
  // Regrading owns a new event clock and file; it never appends with a reset sequence to the execution log.
  const log = options.log ?? new EventLog(directory, { id, now: () => performance.now() }, trial.workspace);
  const runtime = new Shiori(undefined, log.record, seconds, id);
  const cancellation = signals(options.signal);
  let failure: Verification["error"];
  try {
    for (const reference of trial.evidence) {
      const inspected = await inspectEvidence(trial.workspace, runId, reference, { signal: cancellation.signal });
      if (!inspected.available) throw new Error(inspected.error?.message ?? "Recorded evidence is unavailable");
    }
    const input = join(directory, "input.json");
    await atomicJson(input, { trial, verificationId: id, artifacts: join(runDir, "artifacts") });
    await runtime.runProgram({ argv: ["/bin/sh", join(pinned.path, "tests/test.sh")], cwd: pinned.path,
      env: { ...benchmarkEnvironment(), ...verifierEnv,
        RSA_BENCH_WORKSPACE: trial.workspace, RSA_BENCH_TRIAL_ID: runId, RSA_BENCH_RUN_DIR: runDir,
        RSA_BENCH_ARTIFACTS: join(runDir, "artifacts"), RSA_BENCH_TASK_DIR: pinned.path, RSA_BENCH_INPUT: input,
        RSA_BENCH_VERIFIER_DIR: directory }, stdout: join(directory, "stdout.log"), stderr: join(directory, "stderr.log") }, cancellation.signal);
    // Detect a verifier changing the sealed facts, as well as missing/invalid reward output.
    for (const reference of trial.evidence) {
      const inspected = await inspectEvidence(trial.workspace, runId, reference, { signal: cancellation.signal });
      if (!inspected.available) throw new Error("Verifier changed or lost sealed evidence");
    }
    const done = await finishVerification(trial.workspace, runId, id, { status: "completed", endedAt: new Date().toISOString() });
    if (done.changed) log.record("benchmark_verification", benchmarkEventSummary(trial, done.verification));
  } catch (error) {
    failure = errorInfo("VERIFICATION_ERROR", error);
    const done = await finishVerification(trial.workspace, runId, id, { status: "error", endedAt: new Date().toISOString(), error: failure });
    if (done.changed) log.record("benchmark_verification", benchmarkEventSummary(trial, done.verification));
  } finally { try { await runtime.close(); } finally { cancellation.dispose(); } }
  return get(trial.workspace, runId, id);
}

export async function aggregateTasks(workspace: string, datasetPath: string, references: string[], options: { policy?: "all" | "graded"; signal?: AbortSignal } = {}) {
  const { readDataset, prepareMetricInput, meanRewards } = await import("../benchmark/dataset.ts");
  const dataset = await readDataset(datasetPath);
  const results = await Promise.all(references.map(reference => {
    const parts = reference.split("@");
    if (parts.length > 2 || parts.some(part => !part)) throw new Error("Invalid trial@verification reference");
    return get(workspace, parts[0]!, parts[1]);
  }));
  const prepared = prepareMetricInput(dataset, results, options.policy);
  if (!dataset.metric) {
    const rules = new Map<string, string>();
    for (const result of results) if (result.verification?.status === "completed") {
      const key = `${result.trial.task.name}@${result.trial.task.digest}`, verifier = result.verification.task.digest;
      if (rules.has(key) && rules.get(key) !== verifier) throw new Error("Default mean cannot mix verifier Task digests; regrade consistently or supply an explicit metric");
      rules.set(key, verifier);
    }
  }
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(workspace, ".rsa/benchmarks/aggregates", id);
  await mkdir(directory, { recursive: true });
  const input = join(directory, "rewards.jsonl"), output = join(directory, "metrics.json");
  await writeFile(input, prepared.input);
  const metadata = { id, dataset: { name: dataset.name, digest: dataset.digest }, policy: prepared.policy,
    selection: prepared.selection, counts: prepared.counts, excluded: prepared.excluded, metric: dataset.metric ?? null };
  await atomicJson(join(directory, "selection.json"), metadata);
  if (dataset.metric) {
    const bytes = await readFile(dataset.metric.path);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== dataset.metric.digest) throw new Error("Dataset metric changed before execution");
    const reserved = new Set(["rewards.jsonl", "metrics.json", "selection.json", "stdout.log", "stderr.log", "events.jsonl"]);
    for (const file of dataset.files) {
      if (reserved.has(file.path)) throw new Error(`Dataset file conflicts with aggregate output: ${file.path}`);
      const source = join(resolve(dataset.path, ".."), file.path);
      if (`sha256:${await hashFile(source)}` !== file.digest) throw new Error(`Dataset file changed: ${file.path}`);
      await copyFile(source, join(directory, file.path));
      if (`sha256:${await hashFile(join(directory, file.path))}` !== file.digest) throw new Error(`Dataset file changed during copy: ${file.path}`);
    }
    const metric = join(directory, "metric.py"); await writeFile(metric, bytes);
    const log = new EventLog(directory, { id, now: () => performance.now() }, workspace);
    const runtime = new Shiori(undefined, log.record, 120, id), cancellation = signals(options.signal);
    try {
      await runtime.runProgram({ argv: [pythonExecutable(), metric, "-i", input, "-o", output], cwd: directory,
        env: benchmarkEnvironment(), stdout: join(directory, "stdout.log"), stderr: join(directory, "stderr.log") }, cancellation.signal);
      validateRewards(await smallJson(output));
    } finally { try { await runtime.close(); } finally { cancellation.dispose(); } }
  } else {
    const groups = new Map<string, (Record<string, number> | null)[]>();
    for (const selected of prepared.selection) {
      const result = results.find(value => value.trial.workspace === selected.workspace && value.trial.id === selected.trialId)!;
      const key = `${result.trial.task.name}@${result.trial.task.digest}`;
      const rows = groups.get(key) ?? []; rows.push(result.verifier_result.rewards); groups.set(key, rows);
    }
    await atomicJson(output, { byTask: Object.fromEntries([...groups].map(([key, rows]) => [key, meanRewards(rows)])) });
  }
  return { ...metadata, directory, metrics: await smallJson(output) };
}
