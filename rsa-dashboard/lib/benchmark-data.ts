import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { discoverTasks } from "../../rsa/src/benchmark/catalog";
import { get, history, inspectEvidence, verifications } from "../../rsa/src/benchmark/store";
import { readWorkspaceIdentity } from "../../shared/ludens";
import { globalHome, catalog, resolveRun } from "./data";
import type { Event, Manifest } from "./types";
import type { BenchmarkAttachment, BenchmarkCatalog, BenchmarkDetailQuery, BenchmarkEvidence, BenchmarkQuery, BenchmarkResult } from "./benchmarks";

/** Directory discovery is read-only; no Python import, Shiori run, or model call. */
export async function benchmarkCatalog(query: BenchmarkQuery = {}, root = globalHome, repositoryTasksRoot?: string): Promise<BenchmarkCatalog> {
  const scopes = await catalog(root, true);
  const projects = scopes.filter((item): item is typeof item & { workspace: string } => !!item.workspace)
    .map(({ id, workspace }) => ({ id, workspace }));
  const project = query.project ? projects.find(item => item.id === query.project) : projects[0];
  if (query.project && !project) throw new Error("未找到评测工作区");
  if (!project) return { projects, project: null, tasks: [], history: { trials: [], issues: [] }, issues: [] };
  const [tasks, page, owner] = await Promise.all([
    discoverTasks(project.workspace, repositoryTasksRoot),
    history(project.workspace, { taskName: query.taskName, cursor: query.cursor, limit: query.limit ?? 25 }),
    readWorkspaceIdentity(project.workspace),
  ]);
  const historyOwners = new Set([owner.id, ...(owner.historyIds ?? [])]);
  const issues = tasks.diagnostics.map(item => ({ project: project.id, error: `${item.path}: ${item.message}` }));
  const runs = new Map(scopes.find(item => item.id === project.id)!.runs.map(run => [run.id, run]));
  const trials = page.trials.filter(trial => {
    const manifest = runs.get(trial.runId);
    const identity = manifest?.benchmark;
    const matches = owner.id === project.id && historyOwners.has(trial.project) && manifest?.kind === "benchmark" &&
      (trial.legacy || identity && "name" in identity && identity.name === trial.task.name && identity.digest === trial.task.digest);
    if (!matches) page.issues.push({ runId: trial.runId, error: "评测摘要与工作区或 manifest 身份不一致" });
    return !!matches;
  }).map(trial => ({ ...trial, project: project.id }));
  return { projects, project: project.id, tasks: tasks.tasks, history: { ...page, trials }, issues };
}

function evidenceOffset(cursor?: string) {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("无效的证据分页游标");
  return offset;
}

async function selectedResult(project: string, run: string, verification: string | undefined, root: string) {
  const directory = await resolveRun(project, run, root);
  // Trust the registered workspace, not paths claimed by a result file.
  const workspace = dirname(dirname(directory));
  const owner = await readWorkspaceIdentity(workspace);
  const result = await get(workspace, run, verification);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  const identity = manifest.benchmark;
  const historyOwners = new Set([owner.id, ...(owner.historyIds ?? [])]);
  if (owner.id !== project || !historyOwners.has(result.trial.project) ||
    (manifest.workspaceId !== undefined && !historyOwners.has(manifest.workspaceId)) || result.trial.runId !== run || manifest.kind !== "benchmark" ||
    !(result.trial.legacy || identity && "name" in identity && identity.name === result.trial.task.name && identity.digest === result.trial.task.digest))
    throw new Error("评测结果与工作区或 manifest 身份不一致");
  // Links address the currently registered copy; stored execution identity stays untouched.
  return { workspace, result: { ...result, trial: { ...result.trial, project } } };
}
const evidenceReferences = (result: BenchmarkResult) => [...new Map([...result.trial.evidence, ...(result.verification?.evidence ?? [])]
  .map(reference => [JSON.stringify(reference), reference])).values()];

export async function benchmarkEvidence(project: string, run: string, query: BenchmarkDetailQuery = {}, root = globalHome, signal?: AbortSignal): Promise<BenchmarkEvidence> {
  signal?.throwIfAborted();
  const { workspace, result } = await selectedResult(project, run, query.verification, root);
  const page = await verifications(workspace, run, { cursor: query.verificationCursor, limit: 10 });
  const references = evidenceReferences(result);
  const offset = evidenceOffset(query.evidenceCursor), selected = references.slice(offset, offset + 25);
  // Evidence is resolved only for this page, and each inspection streams its original.
  const items = [];
  for (const reference of selected) {
    signal?.throwIfAborted();
    const inspected = await inspectEvidence(workspace, run, reference, { signal });
    items.push({ index: offset + items.length, reference, available: inspected.available,
      ...(inspected.error ? { error: `${inspected.error.code}: ${inspected.error.message}` } : {}),
      ...(inspected.event ? { event: inspected.event as unknown as Event } : {}) });
  }
  return { result, verifications: page, evidence: { items,
    ...(offset + selected.length < references.length ? { nextCursor: String(offset + selected.length) } : {}) } };
}

/** Explicit expansion of one registered diagnostic. Never accept a client-supplied path. */
export async function benchmarkAttachment(project: string, run: string, index: number, verification?: string, root = globalHome, signal?: AbortSignal): Promise<BenchmarkAttachment> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("无效的附件序号");
  const { workspace, result } = await selectedResult(project, run, verification, root);
  const reference = evidenceReferences(result)[index];
  if (!reference || reference.kind !== "file") throw new Error("未找到文本附件引用");
  const inspected = await inspectEvidence(workspace, run, reference, { signal });
  if (!inspected.available || !inspected.path) throw new Error(inspected.error?.message ?? "附件不可用");
  const file = await open(inspected.path, "r");
  try {
    const limit = 256 * 1024, bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    signal?.throwIfAborted();
    const sample = bytes.subarray(0, Math.min(bytesRead, limit));
    if (sample.includes(0)) throw new Error("此附件是二进制文件；请使用原始文件查看");
    return { reference, text: sample.toString("utf8"), truncated: bytesRead > limit };
  } finally { await file.close(); }
}
