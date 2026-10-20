#!/usr/bin/env bun
/** One-time file migration. Readers only support the current Benchmark contract. */
import { constants } from "node:fs";
import { copyFile, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { builtinDefinitions } from "../src/benchmark/builtins.ts";
import { outcomeVerdict, validateResult, type BenchmarkResult, type CaseOutcome } from "../src/benchmark/contract.ts";
import { atomicJson } from "../src/benchmark/store.ts";

interface LegacyResult extends CaseOutcome {
  schemaVersion: 1;
  caseId: string; caseVersion: number; title: string; mode: "offline" | "live";
  status: "running" | "passed" | "failed" | "inconclusive" | "error" | "skipped";
  startedAt: string; endedAt: string | null; durationMs: number | null;
  runId: string; project: string; workspace?: string;
  parameters: Record<string, unknown>; provenance: Record<string, unknown>; error?: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function directories(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(error => {
    if (missing(error)) return []; throw error;
  })).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
}
async function backup(path: string, destination: string) {
  await copyFile(path, destination, constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
}

export async function migrateRun(runDir: string, indexedWorkspace?: string) {
  const resultPath = join(runDir, "benchmark.json"), manifestPath = join(runDir, "manifest.json");
  const old: LegacyResult | BenchmarkResult = await readFile(resultPath, "utf8").then(JSON.parse).catch(error => {
    if (missing(error)) return null; throw error;
  });
  if (!old) return "not-benchmark";
  if (old.schemaVersion === 2) return "current";
  if (old.schemaVersion !== 1) throw new Error("Unsupported benchmark schema");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.benchmark || (manifest.benchmark.caseId ?? manifest.benchmark.id) !== old.caseId ||
    manifest.runId !== old.runId || basename(runDir) !== old.runId) {
    throw new Error("Legacy benchmark and manifest identities do not match");
  }
  const builtin = builtinDefinitions.find(item => item.id === old.caseId);
  if (!builtin || !Number.isSafeInteger(old.caseVersion) || old.caseVersion < 1) throw new Error("Unknown legacy case/version");
  if (!["running", "passed", "failed", "inconclusive", "error", "skipped"].includes(old.status)) throw new Error("Unknown legacy status");
  const workspace = old.workspace ?? manifest.workspace ?? indexedWorkspace;
  if (typeof workspace !== "string" || !workspace) throw new Error("Legacy benchmark workspace is missing");
  const completed = ["passed", "failed", "inconclusive"].includes(old.status);
  const importedFrom = { schemaVersion: 1, status: old.status, migratedAt: new Date().toISOString(),
    result: "benchmark.v1.json", manifest: "manifest.v1.json" };
  const result: BenchmarkResult = {
    schemaVersion: 2,
    definition: {
      ...builtin, id: old.caseId, title: old.title, revision: String(old.caseVersion), mode: old.mode,
      description: "旧结果导入（schema v1）；工况以原日志和限制说明为准，未补造历史源码 hash。",
      scope: (old.limitations ?? []).join("\n"),
    },
    status: completed ? "completed" : old.status as "running" | "error" | "skipped",
    verdict: completed ? outcomeVerdict(old) : null,
    startedAt: old.startedAt, endedAt: old.endedAt, durationMs: old.durationMs,
    runId: old.runId, project: old.project, workspace,
    ...(manifest.parentRunId ? { parentRunId: manifest.parentRunId } : {}),
    trace: manifest.trace ?? {}, parameters: old.parameters,
    provenance: { ...old.provenance, importedFrom },
    checks: old.checks, metrics: old.metrics,
    ...(old.limitations ? { limitations: old.limitations } : {}),
    ...(old.error !== undefined ? { error: old.error } : {}),
  };
  validateResult(result);
  const nextManifest = { ...manifest, kind: "benchmark", workspace,
    benchmark: { id: result.definition.id, revision: result.definition.revision, mode: result.definition.mode },
    provenance: { ...manifest.provenance, importedFrom } };
  await backup(resultPath, join(runDir, "benchmark.v1.json"));
  await backup(manifestPath, join(runDir, "manifest.v1.json"));
  // Commit the result last. A partial migration still has schema v1 and can be rerun.
  await atomicJson(manifestPath, nextManifest);
  await atomicJson(resultPath, result);
  return "migrated";
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    root: { type: "string" }, workspace: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("bun scripts/migrate-benchmarks-v1.ts --root <artifactRoot>\n"
      + "bun scripts/migrate-benchmarks-v1.ts --workspace <workspace>\n"
      + "Migrates schema v1 results in place, preserving *.v1.json backups. No model/device calls.");
    return;
  }
  if (!values.root && !values.workspace) throw new Error("Specify --root or --workspace explicitly");
  const roots = new Map<string, string | undefined>();
  if (values.root) {
    for (const state of await directories(await realpath(resolve(values.root)))) {
      roots.set(join(state, "runs"), undefined);
      const index = await readFile(join(state, "workspace.json"), "utf8").then(JSON.parse).catch(error => {
        if (missing(error)) return null; throw error;
      });
      if (index) {
        if (typeof index.workspace !== "string") throw new Error(`Invalid workspace index: ${state}`);
        roots.set(join(index.workspace, "logs"), index.workspace);
      }
    }
  }
  if (values.workspace) {
    const workspace = await realpath(resolve(values.workspace));
    roots.set(join(workspace, "logs"), workspace);
  }
  const migrated: string[] = [], current: string[] = [], issues: { runDir: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const [root, workspace] of roots) {
    for (const directory of await directories(root)) {
      const runDir = await realpath(directory);
      if (seen.has(runDir)) continue;
      seen.add(runDir);
      try {
        const status = await migrateRun(runDir, workspace);
        if (status === "migrated") migrated.push(runDir);
        if (status === "current") current.push(runDir);
      } catch (error) { issues.push({ runDir, error: String(error) }); }
    }
  }
  console.log(JSON.stringify({ migrated, current, issues }, null, 2));
  if (issues.length) process.exitCode = 1;
}

if (import.meta.main) await main();
