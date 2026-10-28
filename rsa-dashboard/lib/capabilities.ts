import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { catalog } from "./data";
import type { Project } from "./types";
import { discoverTasks } from "../../rsa/src/benchmark/catalog";

const repoRoot = resolve(process.cwd(), "..");

export interface CapabilityEntry {
  id: string;
  kind: "device" | "workspace";
  description: string;
  requiresControl: boolean | null;
  readOnly: boolean | null;
}

interface ControllerJson {
  name: string;
  description?: string;
  requiresControl?: boolean;
  annotations?: { readOnlyHint?: boolean };
}

async function deviceCapabilities(workspace: string): Promise<CapabilityEntry[]> {
  let document: { controllers?: ControllerJson[] };
  try {
    document = JSON.parse(await readFile(join(workspace, "baseware.json"), "utf8"));
  } catch { return []; }
  const controllers = Array.isArray(document.controllers) ? document.controllers : [];
  return controllers
    .filter(item => typeof item?.name === "string")
    .map(item => ({ id: `controller/${item.name}`, kind: "device" as const,
      description: item.description ?? "", requiresControl: item.requiresControl ?? null,
      readOnly: item.annotations?.readOnlyHint ?? null }));
}

const discoverScript = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from rsa_tools._capabilities import discover",
  "caps, _ = discover(sys.argv[2])",
  "print(json.dumps([{'id': 'python/' + c['id'], 'description': c.get('doc') or ''} for c in caps]))",
].join("; ");

async function workspaceCapabilities(workspace: string): Promise<CapabilityEntry[]> {
  const probe = spawnSync("python3", ["-c", discoverScript, join(repoRoot, "rsa", "python"), workspace],
    { encoding: "utf8", timeout: 15000 });
  if (probe.status !== 0) return [];
  try {
    const parsed = JSON.parse(probe.stdout) as { id: string; description: string }[];
    return parsed.filter(item => typeof item?.id === "string")
      .map(item => ({ id: item.id, kind: "workspace" as const,
        description: item.description ?? "", requiresControl: null, readOnly: null }));
  } catch { return []; }
}

export interface CapabilitiesResult {
  project: string | null;
  workspace: string | null;
  groups: { id: string; title: string; items: CapabilityEntry[] }[];
  tasks: { name: string; digest: string; title: string }[];
  issues: { error: string }[];
}

export async function capabilities(projectId?: string): Promise<CapabilitiesResult> {
  const projects: Project[] = await catalog(undefined, true);
  const withWorkspace = projects.filter((item): item is Project & { workspace: string } => !!item.workspace);
  const project = projectId ? withWorkspace.find(item => item.id === projectId) : withWorkspace[0];
  if (projectId && !project) throw new Error("未找到评测工作区");
  if (!project) return { project: null, workspace: null, groups: [], tasks: [], issues: [] };
  const [device, python, tasks] = await Promise.all([
    deviceCapabilities(project.workspace),
    workspaceCapabilities(project.workspace),
    discoverTasks(project.workspace).catch(error => ({ tasks: [], diagnostics: [{ path: "", message: String(error) }] })),
  ]);
  return {
    project: project.id, workspace: project.workspace,
    groups: [
      { id: "device", title: "设备能力 · Baseware 实际目录", items: device },
      { id: "workspace", title: "自创能力 · Workspace @capability", items: python },
    ],
    tasks: tasks.tasks.map(task => ({ name: task.name, digest: task.digest, title: task.title })),
    issues: tasks.diagnostics.map(item => ({ error: `${item.path}: ${item.message}` })),
  };
}
