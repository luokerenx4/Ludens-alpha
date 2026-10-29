import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { readGlobalConfig, updateGlobalConfig, listRegisteredWorkspaces, registerWorkspace, forgetWorkspace,
  registeredWorkspace, readWorkspaceIdentity, type LudensConfig, type WorkspaceRegistration } from "../../shared/ludens";
import { globalHome, clearCatalogCache } from "./data";

export interface CreateWorkspaceInput {
  name: string;
  workspace?: string;
  driver: string;
  driverPackage?: string;
  game?: string;
  cuaCommand?: string;
}
export type WorkspaceSettings = Awaited<ReturnType<typeof workspaceSettings>>;
export async function workspaceSettings(home = globalHome) {
  const [config, workspaces] = await Promise.all([readGlobalConfig(home), listRegisteredWorkspaces(home)]);
  return { home: resolve(home), config, workspaces };
}
function absolutePath(input: unknown, label: string) {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input.trim())) throw new Error(`${label}必须是完整的绝对路径`);
  return resolve(input.trim());
}
export interface WorkspaceRootResult { config: LudensConfig }
export async function updateWorkspaceRoot(input: unknown, home = globalHome): Promise<WorkspaceRootResult> {
  const workspaceRoot = absolutePath(input, "默认工作区目录");
  // The committed value is authoritative. A later registry refresh is a
  // separate read and must never turn a successful save into a failed write.
  const config = await updateGlobalConfig(config => ({ ...config, workspaceRoot }), home);
  return { config };
}
export async function openWorkspace(input: unknown, home = globalHome) {
  const workspace = absolutePath(input, "工作区目录");
  let entry;
  try { entry = await registerWorkspace(workspace, home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("目录不存在或缺少工作区身份；旧版目录请先运行 rsa workspace import <path>。");
    throw error;
  }
  clearCatalogCache();
  return entry;
}
export interface WorkspaceRemovalResult { removed: WorkspaceRegistration | null }
export async function removeWorkspace(input: unknown, home = globalHome): Promise<WorkspaceRemovalResult> {
  if (typeof input !== "string") throw new Error("请选择工作区");
  const removed = await forgetWorkspace(input, home);
  clearCatalogCache();
  return { removed };
}
export async function createWorkspace(input: unknown, signal?: AbortSignal, home = globalHome) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工作区设置必须是对象");
  const value = input as Record<string, unknown>;
  const keys = ["name", "workspace", "driver", "driverPackage", "game", "cuaCommand"];
  for (const [key, field] of Object.entries(value)) {
    if (!keys.includes(key) || typeof field !== "string" || field.length > 2000 || field.includes("\0")) throw new Error(`无效的工作区字段：${key}`);
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || name.length > 120) throw new Error("请输入工作区名称，不含路径分隔符");
  const driver = typeof value.driver === "string" ? value.driver.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(driver)) throw new Error("请输入有效的驱动 ID");
  const config = await readGlobalConfig(home);
  const workspace = value.workspace ? absolutePath(value.workspace, "工作区目录") : join(config.workspaceRoot, name);
  const args = ["init", "--name", name, "--workspace", workspace, "--driver", driver];
  for (const [key, flag] of [["driverPackage", "--driver-package"], ["game", "--game"], ["cuaCommand", "--cua-command"]] as const) {
    const text = (value[key] as string | undefined)?.trim();
    if (text) args.push(flag, text);
  }
  signal?.throwIfAborted();
  const repository = resolve(process.cwd(), "..");
  const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
  for (const key of Object.keys(env)) {
    if (key === "RSA_WORKSPACE" || key === "RSA_SOCKET" || key.startsWith("BASEWARE_")) delete env[key];
  }
  const child = spawn(join(repository, "rsa/bin/rsa"), args, {
    cwd: repository, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const errors: Buffer[] = [];
  let bytes = 0, failure: unknown, terminating = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = (reason: unknown) => {
    if (terminating) return;
    terminating = true; failure = reason; kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const aborted = () => stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  const timeout = setTimeout(() => stop(Object.assign(new Error("创建工作区超时，请检查目录后重试"), { status: 504 })), 55_000);
  const collect = (chunk: Buffer, error = false) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) stop(new Error("创建工作区输出过大"));
    else if (error) errors.push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk));
  child.stderr.on("data", chunk => collect(chunk, true));
  child.once("exit", () => { clearTimeout(forced); kill("SIGKILL"); });
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    if (failure) throw failure;
    if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8").trim() || `创建工作区失败 (${code})`);
  } finally {
    clearTimeout(timeout); clearTimeout(forced); signal?.removeEventListener("abort", aborted); kill("SIGKILL");
  }
  clearCatalogCache();
  return registeredWorkspace((await readWorkspaceIdentity(workspace)).id, home);
}
