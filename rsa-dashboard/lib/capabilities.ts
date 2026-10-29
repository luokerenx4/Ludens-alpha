import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { globalHome, hostRequest, workspaceForProject } from "./data";
import { resolveWorkspaceAddress } from "../../rsa/src/harness/workspace-state";
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

async function deviceCapabilities(workspace: string, signal?: AbortSignal) {
  const document: unknown = JSON.parse(await readFile(join(workspace, "baseware.json"), { encoding: "utf8", signal }));
  if (!isObject(document) || !Array.isArray(document.controllers)) throw new Error("设备目录缺少 controllers 数组");
  const items = document.controllers.map(item => {
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
  const drivers = Array.isArray(document.drivers) ? document.drivers.flatMap(item =>
    isObject(item) && typeof item.id === "string" && item.id ? [{ id: item.id,
      version: typeof item.version === "string" ? item.version : null }] : []) : [];
  const generatedAt = typeof document.generatedAt === "string" && Number.isFinite(Date.parse(document.generatedAt))
    ? document.generatedAt : null;
  return { items, generatedAt, drivers };
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
  project: string;
  workspace: string;
  checkedAt: string;
  groups: { id: "device" | "workspace"; items: CapabilityEntry[] }[];
  tasks: { name: string; digest: string; title: string }[];
  issues: { error: string }[];
  sources: Record<"device" | "workspace" | "tasks", { status: "available" | "partial" | "missing" | "error"; issueCount: number }>;
  deviceSnapshot: { generatedAt: string | null; drivers: { id: string; version: string | null }[] } | null;
}

async function capabilityWorkspace(project: string, expectedWorkspace: string, root: string) {
  if (!expectedWorkspace) throw Object.assign(new Error("必须明确提供预期工作区目录"), { code: "WORKSPACE_SCOPE_REQUIRED", status: 400 });
  const workspace = await workspaceForProject(project, root);
  if (workspace !== expectedWorkspace) throw Object.assign(new Error("工作区登记目录已变化，请刷新工作区列表后重试"),
    { code: "WORKSPACE_SCOPE_CHANGED", status: 409 });
  return workspace;
}

export async function capabilities(project: string, expectedWorkspace: string, root = globalHome, signal?: AbortSignal): Promise<CapabilitiesResult> {
  signal?.throwIfAborted();
  const workspace = await capabilityWorkspace(project, expectedWorkspace, root);
  signal?.throwIfAborted();
  const [device, python, tasks] = await Promise.allSettled([
    deviceCapabilities(workspace, signal),
    workspaceCapabilities(workspace, signal),
    discoverTasks(workspace),
  ]);
  signal?.throwIfAborted();
  const issues: CapabilitiesResult["issues"] = [];
  const missingDevice = device.status === "rejected" && device.reason?.code === "ENOENT";
  for (const [source, result] of [["baseware.json", device], ["Python @capability", python], ["Harbor tasks", tasks]] as const) {
    if (result.status === "rejected" && !(source === "baseware.json" && missingDevice))
      issues.push({ error: `${source}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` });
  }
  if (python.status === "fulfilled") issues.push(...python.value.issues);
  if (tasks.status === "fulfilled") issues.push(...tasks.value.diagnostics.map(item => ({ error: `${item.path}: ${item.message}` })));
  await capabilityWorkspace(project, expectedWorkspace, root);
  return {
    project, workspace, checkedAt: new Date().toISOString(),
    groups: [
      { id: "device", items: device.status === "fulfilled" ? device.value.items : [] },
      { id: "workspace", items: python.status === "fulfilled" ? python.value.items : [] },
    ],
    tasks: tasks.status === "fulfilled" ? tasks.value.tasks.map(task => ({ name: task.name, digest: task.digest, title: task.title })) : [],
    issues,
    sources: {
      device: { status: missingDevice ? "missing" : device.status === "fulfilled" ? "available" : "error", issueCount: device.status === "rejected" && !missingDevice ? 1 : 0 },
      workspace: { status: python.status === "rejected" ? "error" : python.value.issues.length ? "partial" : "available",
        issueCount: python.status === "rejected" ? 1 : python.value.issues.length },
      tasks: { status: tasks.status === "rejected" ? "error" : tasks.value.diagnostics.length ? "partial" : "available",
        issueCount: tasks.status === "rejected" ? 1 : tasks.value.diagnostics.length },
    },
    deviceSnapshot: device.status === "fulfilled" ? { generatedAt: device.value.generatedAt, drivers: device.value.drivers } : null,
  };
}

export interface CapabilityRuntime {
  checkedAt: string;
  host: "reachable" | "unavailable";
  reason?: "not-running" | "unresponsive" | "invalid-status" | "scope-mismatch";
  runId: string | null;
  /** Host's control-session flag; not a physical-device or game readiness test. */
  controlConnected: boolean | null;
}

/** Explicit status read only: never calls a controller, starts a service, or imports a driver. */
export async function capabilityRuntime(project: string, expectedWorkspace: string, root = globalHome): Promise<CapabilityRuntime> {
  const workspace = await capabilityWorkspace(project, expectedWorkspace, root);
  const unavailable = (reason: CapabilityRuntime["reason"]): CapabilityRuntime => ({
    checkedAt: new Date().toISOString(), host: "unavailable", reason, runId: null, controlConnected: null,
  });
  const { socket } = await resolveWorkspaceAddress(workspace);
  let value: unknown;
  try { value = await hostRequest<unknown>(socket, { kind: "status", argv: [] }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(code === "ENOENT" || code === "ECONNREFUSED" ? "not-running"
      : error instanceof SyntaxError ? "invalid-status" : "unresponsive");
  }
  if (!isObject(value) || typeof value.runId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value.runId)
    || value.runId === "." || value.runId === "..") return unavailable("invalid-status");
  const path = join(workspace, "logs", value.runId);
  try {
    if (await realpath(path) !== path) return unavailable("scope-mismatch");
    const manifest: unknown = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    if (!isObject(manifest) || manifest.runId !== value.runId || manifest.workspaceId !== project ||
      manifest.workspace !== workspace || manifest.kind === "benchmark") return unavailable("scope-mismatch");
  } catch { return unavailable("scope-mismatch"); }
  await capabilityWorkspace(project, expectedWorkspace, root);
  return { checkedAt: new Date().toISOString(), host: "reachable", runId: value.runId,
    controlConnected: typeof value.connected === "boolean" ? value.connected : null };
}
