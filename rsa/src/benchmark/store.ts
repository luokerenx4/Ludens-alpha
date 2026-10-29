import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { readRunEvents } from "../../../shared/event-sources.ts";
import { validateVideoReference } from "../../../shared/timeline-media.ts";
import { initializeWorkspaceState } from "../harness/workspace-state.ts";
import { ludensHome, readWorkspaceIdentity, registerWorkspace } from "../../../shared/ludens.ts";
import { isObject, trialSummary, validId, validateTrial, validateVerification, verificationSummary,
  type BenchmarkResult, type EvidenceReference, type Failure, type HistoryQuery, type PageQuery,
  type Trial, type TrialPage, type TrialSummary, type Verification, type VerificationPage } from "./contract.ts";
import { containedPath } from "./task.ts";
import { readReward } from "./reward.ts";

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function indexWorkspace(workspace: string, globalHome = ludensHome()) {
  const state = await initializeWorkspaceState(workspace, globalHome);
  await mkdir(join(state.workspace, "logs"), { recursive: true });
  await registerWorkspace(state.workspace, state.globalHome);
  return state;
}
const ensureId = (id: string) => { if (!validId(id)) throw new Error("Invalid benchmark ID"); return id; };
const runPath = (workspace: string, id: string) => join(workspace, "logs", ensureId(id));
export const verificationDirectory = (workspace: string, runId: string, id: string) => join(runPath(workspace, runId), "verifier", ensureId(id));
async function readJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("Benchmark metadata exceeds 8 MiB; use evidence references");
  return JSON.parse(await readFile(path, "utf8"));
}
async function trustedRun(workspace: string, id: string): Promise<string> {
  ensureId(id);
  return containedPath(await realpath(workspace), `logs/${id}`);
}
async function withTrialLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(directory, ".trial-write-lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await delay(10); }
  }
  if (!acquired) throw new Error("Trial writer busy; an abandoned lock requires explicit recovery");
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function writeTrial(directory: string, trial: Trial) {
  validateTrial(trial);
  await atomicJson(join(directory, "trial.json"), trial);
  await atomicJson(join(directory, "trial-summary.json"), trialSummary(trial));
}
export async function createTrial(workspace: string, trial: Trial): Promise<Trial> {
  validateTrial(trial);
  const root = await realpath(workspace);
  if (trial.workspace !== root || trial.status !== "running") throw new Error("New trial must be running in its canonical workspace");
  await mkdir(join(root, "logs"), { recursive: true });
  await containedPath(root, "logs");
  const directory = runPath(root, trial.id);
  await mkdir(directory, { recursive: true }); await trustedRun(root, trial.id);
  return withTrialLock(directory, async () => {
    if (await stat(join(directory, "trial.json")).catch(() => undefined)) throw new Error("Trial already exists");
    await writeTrial(directory, trial); return trial;
  });
}
export async function readTrial(workspace: string, runId: string): Promise<Trial> {
  const directory = await trustedRun(workspace, runId);
  const trial = await readJson(await containedPath(directory, "trial.json")) as Trial;
  validateTrial(trial);
  const root = await realpath(workspace);
  const owner = await readWorkspaceIdentity(root).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (trial.id !== runId || trial.workspace !== root && trial.project !== owner?.id && !owner?.historyIds?.includes(trial.project)) throw new Error("Trial identity mismatch");
  // Stable ownership lets local evidence move with its workspace. Keep the
  // historical path on disk; all subsequent reads use this canonical root.
  return { ...trial, workspace: root };
}
export type TrialFinish = Pick<Trial, "status" | "endedAt" | "durationMs"> & Partial<Pick<Trial, "conditions" | "subjects" | "evidence" | "limitations" | "error">>;
/** CAS only. The sole Shiori EventLog owner emits a terminal event iff changed is true. */
export async function finishTrial(workspace: string, runId: string, patch: TrialFinish): Promise<{ trial: Trial; changed: boolean }> {
  if (patch.status === "running") throw new Error("finishTrial requires a terminal status");
  const directory = await trustedRun(workspace, runId);
  return withTrialLock(directory, async () => {
    const current = await readTrial(workspace, runId);
    if (current.status !== "running") return { trial: current, changed: false };
    const trial: Trial = { ...current, ...patch };
    await writeTrial(directory, trial); return { trial, changed: true };
  });
}
export async function createVerification(workspace: string, runId: string, verification: Verification): Promise<{ verification: Verification; directory: string }> {
  validateVerification(verification, runId);
  if (verification.status !== "running") throw new Error("New verification must be running");
  const run = await trustedRun(workspace, runId), trial = await readTrial(workspace, runId);
  if (trial.status === "running") throw new Error("Execution must finish before verification");
  const directory = verificationDirectory(workspace, runId, verification.id);
  return withTrialLock(run, async () => {
    await mkdir(join(run, "verifier"), { recursive: true });
    await mkdir(directory); // Unique output directory; no stale reward may be reused.
    await atomicJson(join(directory, "verification.json"), verification);
    return { verification, directory };
  });
}
export async function readVerification(workspace: string, runId: string, id: string): Promise<Verification> {
  const run = await trustedRun(workspace, runId);
  const verification = await readJson(await containedPath(run, `verifier/${ensureId(id)}/verification.json`)) as Verification;
  validateVerification(verification, runId);
  if (verification.id !== id) throw new Error("Verification identity mismatch");
  return verification;
}
export type VerificationFinish = Pick<Verification, "status" | "endedAt"> & Partial<Pick<Verification, "error" | "evidence">>;
export async function finishVerification(workspace: string, runId: string, id: string, patch: VerificationFinish): Promise<{ verification: Verification; changed: boolean }> {
  if (patch.status === "running") throw new Error("finishVerification requires a terminal status");
  const run = await trustedRun(workspace, runId);
  return withTrialLock(run, async () => {
    const current = await readVerification(workspace, runId, id);
    if (current.status !== "running") return { verification: current, changed: false };
    const verification: Verification = { ...current, ...patch };
    validateVerification(verification, runId);
    const directory = verificationDirectory(workspace, runId, id);
    if (verification.status === "completed") await readReward(directory);
    await atomicJson(join(directory, "verification.json"), verification);
    const trial = await readTrial(workspace, runId);
    await writeTrial(run, { ...trial, selectedVerificationId: id });
    return { verification, changed: true };
  });
}
export async function get(workspace: string, runId: string, verificationId?: string): Promise<BenchmarkResult> {
  const trial = await readTrial(workspace, runId), id = verificationId ?? trial.selectedVerificationId;
  const verification = id ? await readVerification(workspace, runId, id) : null;
  let rewards = null;
  if (verification?.status === "completed") {
    rewards = await readReward(verificationDirectory(workspace, runId, verification.id));
  }
  return { trial, verification, verifier_result: { rewards } };
}
function pageLimit(query: PageQuery) {
  const limit = query.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Page limit must be 1..200");
  if (query.cursor !== undefined) ensureId(query.cursor);
  return limit;
}
/** Reads compact summaries only; no rewards, verification history, events, or media. */
export async function history(workspace: string, query: HistoryQuery = {}): Promise<TrialPage> {
  const limit = pageLimit(query), root = await realpath(workspace), logs = join(root, "logs");
  const identity = await readWorkspaceIdentity(root).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  const entries = await readdir(logs, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const ids = entries.filter(entry => entry.isDirectory() && validId(entry.name)).map(entry => entry.name).sort().reverse();
  const trials: TrialSummary[] = [], issues: TrialPage["issues"] = [];
  for (const id of ids) {
    if (query.cursor && id >= query.cursor) continue;
    try {
      const run = await trustedRun(root, id);
      const summary = await readJson(await containedPath(run, "trial-summary.json")) as TrialSummary;
      if (summary.id !== id || summary.runId !== id || summary.workspace !== root && summary.project !== identity?.id && !identity?.historyIds?.includes(summary.project) || typeof summary.project !== "string" || !summary.project ||
          !["running", "completed", "error", "cancelled"].includes(summary.status) || typeof summary.startedAt !== "string" || !Number.isFinite(Date.parse(summary.startedAt)) ||
          !isObject(summary.task) || typeof summary.task.name !== "string" || !/^sha256:[0-9a-f]{64}$/.test(summary.task.digest)) throw new Error("Trial summary identity mismatch");
      if (query.taskName && summary.task.name !== query.taskName) continue;
      trials.push({ ...summary, workspace: root });
      if (trials.length > limit) break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ runId: id, error: String(error) }); }
  }
  const hasMore = trials.length > limit;
  if (hasMore) trials.pop();
  return { trials, ...(hasMore ? { nextCursor: trials.at(-1)!.id } : {}), issues };
}
export async function verifications(workspace: string, runId: string, query: PageQuery = {}): Promise<VerificationPage> {
  const limit = pageLimit(query), run = await trustedRun(workspace, runId);
  const entries = await readdir(join(run, "verifier"), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const ids = entries.filter(entry => entry.isDirectory() && validId(entry.name) && (!query.cursor || entry.name < query.cursor)).map(entry => entry.name).sort().reverse();
  const selected = ids.slice(0, limit);
  return { verifications: await Promise.all(selected.map(async id => verificationSummary(await readVerification(workspace, runId, id)))),
    ...(ids.length > limit ? { nextCursor: selected.at(-1) } : {}) };
}
/** Rebuildable summary index; explicit maintenance, never a query-time legacy adapter. */
export async function rebuildHistoryIndex(workspace: string) {
  const entries = await readdir(join(workspace, "logs"), { withFileTypes: true });
  const issues: { runId: string; error: string }[] = []; let rebuilt = 0;
  for (const entry of entries) if (entry.isDirectory() && validId(entry.name)) {
    try { const trial = await readTrial(workspace, entry.name); await atomicJson(join(workspace, "logs", entry.name, "trial-summary.json"), trialSummary(trial)); rebuilt++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ runId: entry.name, error: String(error) }); }
  }
  return { rebuilt, issues };
}
export interface EvidenceInspection { reference: EvidenceReference; available: boolean; error?: Failure; event?: Record<string, unknown>; path?: string }
/** Resolve only recorded originals. This function never observes a live device or fills missing evidence. */
export async function inspectEvidence(workspace: string, runId: string, reference: EvidenceReference, options: { signal?: AbortSignal } = {}): Promise<EvidenceInspection> {
  try {
    options.signal?.throwIfAborted();
    if (reference.kind === "timeline") {
      const owner = await containedPath(await realpath(workspace), reference.workspaceRelative ?? ".");
      if (!(await stat(owner)).isDirectory()) throw new Error("Timeline owner must be a workspace directory");
      const root = await containedPath(owner, ".rsa/timeline");
      if (reference.timeline.video) {
        validateVideoReference(reference.timeline);
        if (reference.timeline.video.status === "gap") throw new Error(`Recording gap: ${reference.timeline.video.reason ?? "not encoded"}`);
        const state = await readJson(await containedPath(root, reference.timeline.asset + ".json"));
        if (!isObject(state) || state.status !== "ready") throw new Error("Recording segment is not ready");
      }
      const path = await containedPath(root, reference.timeline.asset);
      if (!(await stat(path)).isFile()) throw new Error("Timeline asset is not a file");
      return { reference, available: true, path };
    }
    const run = await trustedRun(workspace, reference.runId ?? runId);
    if (reference.kind === "file") {
      const path = await containedPath(run, reference.path);
      if (!(await stat(path)).isFile()) throw new Error("Evidence path is not a file");
      return { reference, available: true, path };
    }
    if (!reference.path && reference.byteLength === undefined && (reference.eventId || reference.source)) {
      for await (const event of readRunEvents(run, { signal: options.signal })) {
        if ((reference.eventId ? event.origin?.eventId === reference.eventId : (event.origin?.seq ?? event.seq) === reference.seq) &&
            (!reference.source || event.origin?.clockId === reference.source)) return { reference, available: true, event };
      }
      throw new Error("Registered source event is unavailable");
    }
    const path = await containedPath(run, reference.path ?? "events.jsonl");
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Event evidence path is not a file");
    if (reference.byteLength !== undefined) {
      if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || metadata.size < reference.byteLength) throw new Error("Recorded event prefix is unavailable");
      if (reference.seq === undefined && reference.eventId === undefined) return { reference, available: true, path };
      if (reference.byteLength === 0) throw new Error("Recorded event is unavailable");
    }
    const input = createReadStream(path, reference.byteLength === undefined ? {} : { end: reference.byteLength - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        options.signal?.throwIfAborted();
        let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { continue; }
        const origin = isObject(event.origin) ? event.origin : {};
        if ((reference.eventId ? origin.eventId === reference.eventId : event.seq === reference.seq) && (!reference.source || isObject(event.source) && (isObject(event.origin) && event.origin.clockId === reference.source))) return { reference, available: true, event, path };
      }
    } finally { lines.close(); input.destroy(); }
    throw new Error("Recorded event is unavailable");
  } catch (error) {
    options.signal?.throwIfAborted();
    return { reference, available: false, error: { code: "EVIDENCE_UNAVAILABLE", message: String(error) } };
  }
}
