import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { TaskDefinition } from "./contract.ts";
import { readTask } from "./task.ts";

export const repositoryTasksRoot = fileURLToPath(new URL("../../benchmarks/tasks/", import.meta.url));
export async function discoverTasks(workspace: string, repositoryRoot = repositoryTasksRoot) {
  const tasks: TaskDefinition[] = [], diagnostics: { path: string; message: string }[] = [];
  async function visit(path: string, source: TaskDefinition["source"]) {
    if ((await stat(join(path, "task.toml")).catch(() => undefined))?.isFile()) {
      try { tasks.push(await readTask(path, source)); } catch (error) { diagnostics.push({ path, message: String(error) }); }
      return;
    }
    const entries = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(join(path, entry.name), source);
  }
  await visit(repositoryRoot, "repository");
  if (resolve(workspace, "benchmarks/tasks") !== resolve(repositoryRoot)) await visit(join(workspace, "benchmarks/tasks"), "workspace");
  return { tasks: tasks.sort((a, b) => a.name.localeCompare(b.name) || a.digest.localeCompare(b.digest)), diagnostics };
}
export async function resolveTask(workspace: string, name: string, digest?: string): Promise<TaskDefinition> {
  const catalog = await discoverTasks(workspace);
  const matches = catalog.tasks.filter(task => task.name === name && (!digest || task.digest === digest));
  const identities = new Set(matches.map(task => task.digest));
  if (!matches.length) throw new Error(`Task not found: ${name}${digest ? `@${digest}` : ""}`);
  if (identities.size > 1) throw new Error(`Ambiguous task ${name}; specify its digest`);
  return matches.find(task => task.source === "workspace") ?? matches[0]!;
}
