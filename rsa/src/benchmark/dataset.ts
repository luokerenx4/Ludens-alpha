import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { isObject, validateIdentity, validateRewards, type BenchmarkResult, type DatasetDefinition, type DatasetTask, type Rewards } from "./contract.ts";
import { resolveTask } from "./catalog.ts";
import { containedPath, hashFile } from "./task.ts";

/** Harbor DatasetManifest content hash includes digests, not mutable local discovery paths. */
export function datasetDigest(tasks: DatasetTask[], files: { path: string; digest: string }[] = []): string {
  let material = tasks.map(task => task.digest.slice(7)).sort().join(",");
  if (files.length) material += ";" + files.map(file => `${file.path}:${file.digest.slice(7)}`).sort().join(",");
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}
export async function readDataset(path: string): Promise<DatasetDefinition> {
  const file = resolve(path), root = dirname(file), raw = parse(await readFile(file, "utf8"));
  if (!isObject(raw) || raw.schema_version !== undefined && raw.schema_version !== "1.0" || !isObject(raw.dataset)) throw new Error("Expected Harbor Dataset schema_version 1.0 and [dataset]");
  const info = raw.dataset;
  const tasks = raw.tasks ?? [], fileRefs = raw.files ?? [];
  if (!Array.isArray(tasks) || !Array.isArray(fileRefs)) throw new Error("Dataset tasks and files must be arrays");
  const parsedTasks: DatasetTask[] = tasks.map(item => {
    if (!isObject(item) || Object.keys(item).some(key => !["name", "digest"].includes(key))) throw new Error("Dataset task references contain only name and digest");
    validateIdentity(item as unknown as DatasetTask);
    return { name: item.name as string, digest: item.digest as string };
  });
  const files: DatasetDefinition["files"] = [];
  for (const ref of fileRefs) {
    if (!isObject(ref) || typeof ref.path !== "string" || !ref.path || /[\\/]/.test(ref.path) || [".", ".."].includes(ref.path) || Object.keys(ref).some(key => !["path", "digest"].includes(key))) throw new Error("Dataset file references require a simple filename");
    const digest = `sha256:${await hashFile(await containedPath(root, ref.path))}`;
    if (ref.digest !== undefined && ref.digest !== "" && ref.digest !== digest) throw new Error(`Dataset file digest mismatch: ${ref.path}`);
    files.push({ path: ref.path, digest });
  }
  const digest = datasetDigest(parsedTasks, files);
  validateIdentity({ name: info.name as string, digest, version: info.version as string | undefined });
  const metricPath = join(root, "metric.py");
  const metric = await stat(metricPath).then(async () => ({ path: await containedPath(root, "metric.py"), digest: `sha256:${await hashFile(await containedPath(root, "metric.py"))}` }), error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (raw.metadata !== undefined && !isObject(raw.metadata)) throw new Error("Dataset metadata must be a table");
  return { name: info.name as string, version: info.version as string | undefined, description: info.description as string | undefined,
    path: file, digest, tasks: parsedTasks, files, metadata: (raw.metadata ?? {}) as Record<string, unknown>, ...(metric ? { metric } : {}) };
}
export async function resolveDatasetTasks(workspace: string, dataset: DatasetDefinition) {
  return Promise.all(dataset.tasks.map(task => resolveTask(workspace, task.name, task.digest)));
}
/** Standard metric input is rewards or null only. Provenance stays alongside, never inside, those rows. */
export function prepareMetricInput(dataset: DatasetDefinition, results: BenchmarkResult[], policy: "all" | "graded" = "all") {
  const seen = new Set<string>(), rows: (Rewards | null)[] = [], selection: { workspace: string; trialId: string; verificationId: string | null }[] = [];
  const excluded: { workspace: string; trialId: string; reason: string }[] = [];
  let valid = 0, executionErrors = 0, verificationErrors = 0;
  for (const result of results) {
    const trial = result.trial, key = `${trial.workspace}\0${trial.id}`;
    if (seen.has(key)) throw new Error(`Duplicate trial in aggregate: ${trial.id}; regrading does not create an independent sample`);
    seen.add(key);
    if (!dataset.tasks.some(task => task.name === trial.task.name && task.digest === trial.task.digest)) throw new Error(`Trial ${trial.id} is outside the pinned dataset`);
    if (trial.status === "running" || result.verification?.status === "running") throw new Error(`Trial ${trial.id} has unfinished execution or verification`);
    if (trial.status !== "completed") executionErrors++;
    if (!result.verification || result.verification.status === "error") verificationErrors++;
    const reward = result.verifier_result.rewards;
    if (reward !== null) { validateRewards(reward); valid++; }
    if (policy === "graded" && reward === null) { excluded.push({ workspace: trial.workspace, trialId: trial.id, reason: "No valid selected reward" }); continue; }
    rows.push(reward);
    selection.push({ workspace: trial.workspace, trialId: trial.id, verificationId: result.verification?.id ?? null });
  }
  return { rows, input: rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), selection, excluded, policy,
    counts: { trials: results.length, included: rows.length, valid, executionErrors, verificationErrors } };
}
/** Harbor default mean: null and missing dimensions contribute zero. Never used across mixed tasks implicitly. */
export function meanRewards(rows: (Rewards | null)[]): Rewards {
  if (!rows.length) throw new Error("Mean requires at least one trial");
  const keys = [...new Set(rows.flatMap(row => Object.keys(row ?? {})))].sort();
  if (keys.length <= 1) return { mean: rows.reduce((total, row) => total + (row === null ? 0 : Object.values(row)[0] ?? 0), 0) / rows.length };
  return Object.fromEntries(keys.map(key => [key, rows.reduce((total, row) => total + (row?.[key] ?? 0), 0) / rows.length]));
}
