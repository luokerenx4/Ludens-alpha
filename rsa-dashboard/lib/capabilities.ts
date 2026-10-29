import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { globalHome, catalog } from "./data";
import type { Project } from "./types";
import { discoverTasks } from "../../rsa/src/benchmark/catalog";
import { isObject } from "../../rsa/src/benchmark/contract";
import { pythonExecutable, pythonEnvironment, pythonModulePaths } from "../../shared/python";

export interface CapabilityEntry {
  id: string;
  kind: "device" | "workspace";
  description: string;
  requiresControl: boolean | null;
  readOnly: boolean | null;
}

async function deviceCapabilities(workspace: string, signal?: AbortSignal): Promise<CapabilityEntry[]> {
  const document: unknown = JSON.parse(await readFile(join(workspace, "baseware.json"), { encoding: "utf8", signal }));
  if (!isObject(document) || !Array.isArray(document.controllers)) throw new Error("设备目录缺少 controllers 数组");
  return document.controllers.map(item => {
    if (!isObject(item) || typeof item.name !== "string" || !item.name
        || item.description !== undefined && typeof item.description !== "string"
        || item.requiresControl !== undefined && typeof item.requiresControl !== "boolean"
        || item.annotations !== undefined && !isObject(item.annotations)
        || isObject(item.annotations) && item.annotations.readOnlyHint !== undefined && typeof item.annotations.readOnlyHint !== "boolean") {
      throw new Error("设备目录包含无效能力声明");
    }
    return { id: `controller/${item.name}`, kind: "device" as const,
      description: item.description ?? "", requiresControl: item.requiresControl ?? null,
      readOnly: isObject(item.annotations) && typeof item.annotations.readOnlyHint === "boolean" ? item.annotations.readOnlyHint : null };
  });
}

async function workspaceCapabilities(workspace: string, signal?: AbortSignal) {
  const paths = pythonModulePaths();
  const env = pythonEnvironment({ RSA_WORKSPACE: workspace, PYTHONPATH: paths.join(delimiter), PYTHONDONTWRITEBYTECODE: "1" });
  // The bridge only parses source. Keep workspace modules out of Python's startup
  // search path so names such as json.py cannot execute while importing the bridge.
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(pythonExecutable(), ["-B", "-m", "rsa_tools._bridge"], {
      cwd: paths[0], env, signal, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
    }, (error, output, stderr) => {
      if (error) reject(new Error(`Python capability discovery failed: ${stderr || output || error.message}`, { cause: error }));
      else resolve(output);
    });
    child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
    child.stdin?.end(JSON.stringify({ action: "discover", workspace }));
  });
  const result: unknown = JSON.parse(stdout);
  if (!isObject(result) || !Array.isArray(result.capabilities) || !Array.isArray(result.diagnostics)) throw new Error("Invalid Python discovery response");
  const items: CapabilityEntry[] = result.capabilities.map(item => {
    if (!isObject(item) || !isObject(item.origin) || typeof item.origin.path !== "string"
        || typeof item.origin.function !== "string" || typeof item.description !== "string") throw new Error("Invalid Python capability declaration");
    return { id: `python/${item.origin.path}:${item.origin.function}`, kind: "workspace",
      description: item.description, requiresControl: null, readOnly: null };
  });
  const issues = result.diagnostics.map(item => {
    if (!isObject(item) || typeof item.path !== "string" || typeof item.message !== "string") throw new Error("Invalid Python discovery diagnostic");
    return { error: `${item.path}${typeof item.line === "number" ? `:${item.line}` : ""}: ${item.message}` };
  });
  return { items, issues };
}

export interface CapabilitiesResult {
  project: string | null;
  workspace: string | null;
  groups: { id: string; title: string; items: CapabilityEntry[] }[];
  tasks: { name: string; digest: string; title: string }[];
  issues: { error: string }[];
}

export async function capabilities(projectId?: string, root = globalHome, signal?: AbortSignal): Promise<CapabilitiesResult> {
  signal?.throwIfAborted();
  const projects: Project[] = await catalog(root, true);
  const withWorkspace = projects.filter((item): item is Project & { workspace: string } => !!item.workspace);
  const project = projectId ? withWorkspace.find(item => item.id === projectId) : withWorkspace[0];
  if (projectId && !project) throw new Error("未找到能力工作区");
  if (!project) return { project: null, workspace: null, groups: [], tasks: [], issues: [] };
  signal?.throwIfAborted();
  const [device, python, tasks] = await Promise.allSettled([
    deviceCapabilities(project.workspace, signal),
    workspaceCapabilities(project.workspace, signal),
    discoverTasks(project.workspace),
  ]);
  signal?.throwIfAborted();
  const issues: CapabilitiesResult["issues"] = [];
  for (const [source, result] of [["baseware.json", device], ["Python 能力发现", python], ["评测任务发现", tasks]] as const) {
    if (result.status === "rejected") issues.push({ error: `${source}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` });
  }
  if (python.status === "fulfilled") issues.push(...python.value.issues);
  if (tasks.status === "fulfilled") issues.push(...tasks.value.diagnostics.map(item => ({ error: `${item.path}: ${item.message}` })));
  return {
    project: project.id, workspace: project.workspace,
    groups: [
      { id: "device", title: "设备能力 · 连接时目录快照", items: device.status === "fulfilled" ? device.value : [] },
      { id: "workspace", title: "自创能力 · Workspace @capability", items: python.status === "fulfilled" ? python.value.items : [] },
    ],
    tasks: tasks.status === "fulfilled" ? tasks.value.tasks.map(task => ({ name: task.name, digest: task.digest, title: task.title })) : [],
    issues,
  };
}
