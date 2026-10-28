import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, type TaskDefinition } from "./contract.ts";

export interface RunConfiguration {
  task: string; argv: string[]; cwd?: string; workspace?: "current" | "isolated";
  seconds?: number; parameters?: Record<string, unknown>; onlineModel?: boolean;
}
export interface TaskBinding { path: string; configuration: RunConfiguration }
export type TaskWithBindings = TaskDefinition & { bindings: TaskBinding[] };
export const repositoryRunsRoot = fileURLToPath(new URL("../../benchmarks/runs/", import.meta.url));

function configuration(value: unknown): RunConfiguration {
  if (!isObject(value) || typeof value.task !== "string" || !value.task || !Array.isArray(value.argv) || !value.argv.length || value.argv.some(v => typeof v !== "string" || !v)
      || value.workspace !== undefined && value.workspace !== "current" && value.workspace !== "isolated"
      || value.cwd !== undefined && typeof value.cwd !== "string"
      || value.seconds !== undefined && (typeof value.seconds !== "number" || !Number.isFinite(value.seconds) || value.seconds <= 0)
      || value.parameters !== undefined && !isObject(value.parameters)
      || value.onlineModel !== undefined && typeof value.onlineModel !== "boolean"
      || Object.keys(value).some(key => !["task", "argv", "cwd", "workspace", "seconds", "parameters", "onlineModel"].includes(key))) throw new Error("Invalid native Shiori run configuration");
  return value as unknown as RunConfiguration;
}

/** Read each source directory once, matching author-declared task names, not filenames. */
export async function discoverBindings(directory: string) {
  const bindings: TaskBinding[] = [], diagnostics: { path: string; message: string }[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(directory, entry.name);
    try { bindings.push({ path, configuration: configuration(JSON.parse(await readFile(path, "utf8"))) }); }
    catch (error) { diagnostics.push({ path, message: String(error) }); }
  }
  return { bindings, diagnostics };
}

export async function readRunConfiguration(task: TaskDefinition, workspace: string, file?: string): Promise<RunConfiguration> {
  if (file) {
    const value = configuration(JSON.parse(await readFile(resolve(workspace, file), "utf8")));
    if (value.task !== task.name) throw new Error("Run configuration names another Task");
    return value;
  }
  const discovered = "bindings" in task ? (task as TaskWithBindings).bindings
    : (await discoverBindings(task.source === "repository" ? repositoryRunsRoot : join(workspace, "benchmarks/runs"))).bindings;
  const matches = discovered.filter(binding => binding.configuration.task === task.name);
  if (matches.length === 1) return matches[0]!.configuration;
  throw new Error(matches.length
    ? `Multiple program bindings for ${task.name}; select --config <path>: ${matches.map(binding => binding.path).join(", ")}`
    : `No program binding for ${task.name}; add a JSON configuration with task=${JSON.stringify(task.name)} to ${task.source === "repository" ? repositoryRunsRoot : join(workspace, "benchmarks/runs")} or select --config <path>`);
}
