/** Explicit, one-time offline migration. Normal reads and execution never import this module. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isObject, trialSummary, validId, validateTrial, validateVerification, type EvidenceReference, type Rewards, type Trial, type Verification } from "./contract.ts";
import { atomicJson } from "./store.ts";
import { containedPath } from "./task.ts";
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
async function json(path: string) { if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("Legacy metadata exceeds 8 MiB"); return JSON.parse(await readFile(path, "utf8")); }
export async function importLegacyTrial(workspace: string, runId: string): Promise<{ imported: boolean; runId: string; verifications?: number }> {
  if (!validId(runId)) throw new Error("Invalid legacy run ID");
  const root = await realpath(workspace), run = await containedPath(root, `logs/${runId}`);
  const lock = join(run, ".legacy-import-lock"); await mkdir(lock);
  try {
    if (await stat(join(run, "trial.json")).catch(() => undefined)) return { imported: false, runId };
    const old = await json(await containedPath(run, "benchmark.json"));
    if (!isObject(old) || old.schemaVersion !== 3 || old.runId !== runId || old.workspace !== root || !isObject(old.definition) || !["completed", "error", "cancelled"].includes(String(old.status)) || typeof old.startedAt !== "string" || typeof old.endedAt !== "string") throw new Error("Unsupported, unfinished, or damaged legacy benchmark");
    const importedAt = new Date().toISOString(), originalId = String(old.definition.id);
    const task = { name: `legacy/${originalId.replace(/[^a-zA-Z0-9_-]/g, "-") || "benchmark"}`, digest: digest(old.definition) };
    const limitations = ["Imported legacy measurements; task digest identifies the original definition, not a Harbor package.", "Original checks, unknown values, raw reports and manual revision provenance remain diagnostics; no verifier execution or re-verifiability is claimed."];
    const executionEvidence: EvidenceReference = { kind: "file", path: "benchmark.json", label: "Original execution" };
    const trial: Trial = { schemaVersion: 1, id: runId, runId, task, workspace: root, project: String(old.project), status: old.status as Trial["status"], startedAt: old.startedAt, endedAt: old.endedAt, ...(typeof old.durationMs === "number" ? { durationMs: old.durationMs } : {}), parameters: isObject(old.parameters) ? old.parameters : {}, conditions: isObject(old.conditions) ? old.conditions : {}, subjects: Array.isArray(old.subjects) ? old.subjects : [], evidence: [executionEvidence], limitations, ...(old.error ? { error: { code: "LEGACY_EXECUTION_ERROR", message: String(old.error) } } : {}), legacy: { source: "benchmark.json", originalId, importedAt, limitations } };
    const names = await readdir(join(run, "reports")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const reports: Record<string, unknown>[] = [];
    for (const name of names.filter(name => name.endsWith(".json") && !name.endsWith(".raw.json")).sort()) {
      const report = await json(await containedPath(run, `reports/${name}`));
      if (!isObject(report) || !validId(report.id) || name !== `${report.id}.json` || report.runId !== runId || report.schemaVersion !== 1) throw new Error(`Damaged legacy report: ${name}`);
      reports.push(report);
    }
    const byId = new Map(reports.map(report => [report.id as string, report])), sorted: Record<string, unknown>[] = [], seen = new Set<string>(), visiting = new Set<string>();
    const visit = (report: Record<string, unknown>) => {
      const id = report.id as string;
      if (seen.has(id)) return; if (visiting.has(id)) throw new Error("Cyclic legacy report revisions"); visiting.add(id);
      if (report.previousReportId) { const parent = byId.get(String(report.previousReportId)); if (!parent) throw new Error("Missing legacy report revision parent"); visit(parent); }
      visiting.delete(id); seen.add(id); sorted.push(report);
    };
    reports.forEach(visit);
    for (const report of sorted) {
      const id = report.id as string, source = `reports/${id}.json`, available = isObject(report.outcome) && Array.isArray(report.outcome.metrics);
      const rewards: Rewards = Object.create(null);
      if (available) for (const metric of (report.outcome as { metrics: unknown[] }).metrics) if (isObject(metric) && typeof metric.id === "string" && typeof metric.value === "number" && Number.isFinite(metric.value)) rewards[metric.id] = metric.value;
      const verification: Verification = { schemaVersion: 1, id, trialId: runId, task: { ...task, digest: digest({ definition: old.definition, protocolVersion: report.protocolVersion }) }, status: available ? "completed" : "error", startedAt: String(report.createdAt), endedAt: String(report.createdAt), reason: String(report.reason ?? "legacy import"), evidence: [{ kind: "file", path: source, label: "Original report including checks and revisions" }], ...(available ? {} : { error: { code: "LEGACY_INVALID_REPORT", message: "Original report was invalid; see the unchanged source" } }), legacy: { source, originalId: id, importedAt, limitations } };
      validateVerification(verification, runId);
      const directory = join(run, "verifier", id); await mkdir(directory, { recursive: true });
      if (available) await atomicJson(join(directory, "reward.json"), rewards);
      await atomicJson(join(directory, "verification.json"), verification); trial.selectedVerificationId = id;
    }
    validateTrial(trial);
    // Commit last. Failure leaves originals intact and no partial trial visible.
    await atomicJson(join(run, "trial.json"), trial); await atomicJson(join(run, "trial-summary.json"), trialSummary(trial));
    return { imported: true, runId, verifications: sorted.length };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function importLegacyHistory(workspace: string) {
  const entries = await readdir(join(workspace, "logs"), { withFileTypes: true });
  const imported: string[] = [], skipped: string[] = [], issues: { runId: string; error: string }[] = [];
  for (const entry of entries) if (entry.isDirectory() && validId(entry.name)) {
    if (!(await stat(join(workspace, "logs", entry.name, "benchmark.json")).catch(() => undefined))) continue;
    try { const result = await importLegacyTrial(workspace, entry.name); (result.imported ? imported : skipped).push(entry.name); } catch (error) { issues.push({ runId: entry.name, error: String(error) }); }
  }
  return { imported, skipped, issues };
}
