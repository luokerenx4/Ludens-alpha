import type { TimelineAssetReference } from "../../../shared/timeline-types";

/** Public file contract. Shiori owns execution; these types do not start work or infer a verdict. */
export type Rewards = Record<string, number>;
export interface TaskIdentity { name: string; digest: string; version?: string }
export interface TaskConfig {
  schema_version: "1.4";
  task: { name: string; version?: string; description?: string; authors?: unknown[]; keywords?: string[] };
  metadata?: Record<string, unknown>;
  verifier?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  solution?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface TaskDefinition extends TaskIdentity {
  path: string; title: string; source: "repository" | "workspace";
  schemaVersion: "1.4"; config: TaskConfig; unsupportedRequirements: string[];
}
export interface SubjectReference { id: string; path?: string; sha256?: string; revision?: string }
export type EvidenceReference = (
  | { kind: "file"; path: string; runId?: string; sizeBytes?: number }
  | { kind: "event"; runId: string; seq?: number; eventId?: string; source?: string;
      /** Optional recorded byte prefix; later events are outside this reference. */
      path?: string; byteLength?: number }
  | { kind: "timeline"; timeline: TimelineAssetReference; recordId?: string; sequence?: number;
      /** Timeline owner relative to trial.workspace, for an isolated child workspace. */
      workspaceRelative?: string }
) & { label?: string; reward?: string };
export interface Failure { code: string; message: string }
export interface LegacyImport { source: string; originalId: string; importedAt: string; limitations: string[] }
export type TrialStatus = "running" | "completed" | "error" | "cancelled";
export type VerificationStatus = "running" | "completed" | "error";
export interface Trial {
  schemaVersion: 1; id: string; runId: string; task: TaskIdentity;
  workspace: string; project: string; parentRunId?: string; trace?: Record<string, string>;
  status: TrialStatus; startedAt: string; endedAt?: string; durationMs?: number;
  parameters: Record<string, unknown>; conditions: Record<string, unknown>;
  subjects: SubjectReference[]; evidence: EvidenceReference[];
  limitations?: string[]; selectedVerificationId?: string; error?: Failure; legacy?: LegacyImport;
}
export interface Verification {
  schemaVersion: 1; id: string; trialId: string; task: TaskIdentity;
  status: VerificationStatus; startedAt: string; endedAt?: string;
  reason: string; evidence: EvidenceReference[]; error?: Failure; legacy?: LegacyImport;
}
/** Reward bytes live only in verifier/<id>/reward.json (or Harbor reward.txt). */
export interface BenchmarkResult {
  trial: Trial; verification: Verification | null;
  verifier_result: { rewards: Rewards | null };
}
export type TrialSummary = Pick<Trial, "id" | "runId" | "task" | "workspace" | "project" | "status" | "startedAt" | "endedAt" | "durationMs" | "selectedVerificationId" | "error" | "legacy">;
export type VerificationSummary = Pick<Verification, "id" | "trialId" | "task" | "status" | "startedAt" | "endedAt" | "reason" | "error" | "legacy">;
export interface PageQuery { cursor?: string; limit?: number }
export interface HistoryQuery extends PageQuery { taskName?: string }
export interface TrialPage { trials: TrialSummary[]; nextCursor?: string; issues: { runId: string; error: string }[] }
export interface VerificationPage { verifications: VerificationSummary[]; nextCursor?: string }
export interface DatasetTask { name: string; digest: string }
export interface DatasetDefinition {
  name: string; description?: string; version?: string; tasks: DatasetTask[]; path: string; digest: string;
  files: { path: string; digest: string }[]; metadata: Record<string, unknown>;
  metric?: { path: string; digest: string };
}

export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value); }
export function validateIdentity(value: TaskIdentity): void {
  if (!isObject(value) || typeof value.name !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value.name) || value.name.includes("..") ||
      !/^sha256:[0-9a-f]{64}$/.test(value.digest) || (value.version !== undefined && !nonempty(value.version))) throw new Error("Invalid task name/digest identity");
}
export function validateRewards(value: unknown): asserts value is Rewards {
  if (!isObject(value) || Object.values(value).some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error("Reward must be a flat object of finite numbers");
}
function validateEvidence(items: EvidenceReference[]) {
  if (!Array.isArray(items)) throw new Error("Evidence must be an array");
  for (const item of items) {
    if (!isObject(item) || !["file", "event", "timeline"].includes(item.kind)) throw new Error("Invalid evidence reference");
    if (item.kind === "file" && !nonempty(item.path)) throw new Error("File evidence requires a path");
    if (item.kind === "event" && (!validId(item.runId) || !(Number.isSafeInteger(item.seq) && item.seq! >= 0 || nonempty(item.eventId)) && !(Number.isSafeInteger(item.byteLength) && item.byteLength! >= 0 && nonempty(item.path)))) throw new Error("Event evidence requires a fixed event or prefix");
    if (item.kind === "timeline" && (!isObject(item.timeline) || !nonempty(item.timeline.asset))) throw new Error("Invalid timeline evidence");
  }
}
export function validateTrial(trial: Trial): void {
  if (!isObject(trial) || trial.schemaVersion !== 1 || !validId(trial.id) || trial.id !== trial.runId || !nonempty(trial.workspace) || !nonempty(trial.project) ||
      !nonempty(trial.startedAt) || !["running", "completed", "error", "cancelled"].includes(trial.status) || !isObject(trial.parameters) || !isObject(trial.conditions) || !Array.isArray(trial.subjects) ||
      (trial.status !== "running" && !nonempty(trial.endedAt)) || (trial.durationMs !== undefined && (!Number.isFinite(trial.durationMs) || trial.durationMs < 0))) throw new Error("Invalid benchmark trial");
  validateIdentity(trial.task); validateEvidence(trial.evidence);
  if (trial.selectedVerificationId !== undefined && !validId(trial.selectedVerificationId)) throw new Error("Invalid selected verification ID");
}
export function validateVerification(value: Verification, trialId?: string): void {
  if (!isObject(value) || value.schemaVersion !== 1 || !validId(value.id) || !validId(value.trialId) || trialId !== undefined && value.trialId !== trialId ||
      !["running", "completed", "error"].includes(value.status) || !nonempty(value.startedAt) || typeof value.reason !== "string" ||
      value.status !== "running" && !nonempty(value.endedAt)) throw new Error("Invalid benchmark verification");
  validateIdentity(value.task); validateEvidence(value.evidence);
}
export function trialSummary(trial: Trial): TrialSummary {
  const { id, runId, task, workspace, project, status, startedAt, endedAt, durationMs, selectedVerificationId, error, legacy } = trial;
  return { id, runId, task, workspace, project, status, startedAt, endedAt, durationMs, selectedVerificationId, error, legacy };
}
export function verificationSummary(value: Verification): VerificationSummary {
  const { id, trialId, task, status, startedAt, endedAt, reason, error, legacy } = value;
  return { id, trialId, task, status, startedAt, endedAt, reason, error, legacy };
}
export function benchmarkEventSummary(trial: Trial, verification?: Verification | null) {
  return { benchmarkId: trial.task.name, benchmarkRunId: trial.runId, taskDigest: trial.task.digest,
    executionStatus: trial.status, verificationStatus: verification?.status ?? "missing", verificationId: verification?.id ?? null,
    error: verification?.error ?? trial.error };
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function comparisonChanges(result: BenchmarkResult, baseline: BenchmarkResult): string[] {
  return [["task", result.trial.task, baseline.trial.task], ["verifier", result.verification?.task, baseline.verification?.task],
    ["parameters", result.trial.parameters, baseline.trial.parameters], ["conditions", result.trial.conditions, baseline.trial.conditions]]
    .filter(([, a, b]) => canonical(a) !== canonical(b)).map(([key]) => key as string);
}
export function compareResults(result: BenchmarkResult, baseline: BenchmarkResult) {
  const changes = comparisonChanges(result, baseline);
  return { changes, sameExecution: result.trial.workspace === baseline.trial.workspace && result.trial.id === baseline.trial.id,
    verifications: { result: result.verification?.id ?? null, baseline: baseline.verification?.id ?? null },
    subjectsChanged: canonical(result.trial.subjects) !== canonical(baseline.trial.subjects),
    rewards: [...new Set([...Object.keys(result.verifier_result.rewards ?? {}), ...Object.keys(baseline.verifier_result.rewards ?? {})])].sort().map(key => {
      const current = result.verifier_result.rewards, prior = baseline.verifier_result.rewards;
      const value = current && Object.hasOwn(current, key) && Number.isFinite(current[key]) ? current[key]! : null;
      const previous = prior && Object.hasOwn(prior, key) && Number.isFinite(prior[key]) ? prior[key]! : null;
      return { key, value, baseline: previous, delta: value !== null && previous !== null ? value - previous : null };
    }) };
}
