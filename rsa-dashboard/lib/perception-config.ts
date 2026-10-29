import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalHome, hostRequest, workspaceForProject } from "./data";
import { resolveWorkspaceAddress } from "../../rsa/src/harness/workspace-state";
import { withWorkspaceRegistrationLock } from "../../shared/ludens";

/** Workspace overrides only; absent values inherit the perception process environment. */
export interface PerceptionSettings {
  hotSeconds: number;
  videoSegmentSeconds: number;
  videoIdleSeconds: number;
}
export type PerceptionSettingsPatch = Partial<{ [K in keyof PerceptionSettings]: number | null }>;

export interface PerceptionRuntimeSnapshot {
  checkedAt: string;
  connection: "reachable" | "unavailable";
  reason?: "not-running" | "unresponsive" | "invalid-status" | "scope-mismatch";
  runId: string | null;
  perception: {
    state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
    generation: string | null;
    pid: number | null;
    sampleHz: number | null;
    values: PerceptionSettings | null;
    valueStatus: "current" | "last-loaded" | "unavailable";
    persistent: boolean | null;
    error?: string;
  } | null;
}

export const PERCEPTION_LIMITS = {
  hotSeconds: { min: 10, max: 3600 },
  videoSegmentSeconds: { min: 10, max: 3600 },
  videoIdleSeconds: { min: 1, max: 600 },
} as const;
const KEYS = Object.keys(PERCEPTION_LIMITS) as (keyof PerceptionSettings)[];

export function parsePerceptionPatch(input: unknown): PerceptionSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("设置必须是 JSON 对象");
  const patch: PerceptionSettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(PERCEPTION_LIMITS, key)) throw new Error("未知的工作区设置: " + key);
    const name = key as keyof PerceptionSettings, { min, max } = PERCEPTION_LIMITS[name];
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max))
      throw new Error(`设置值必须是 ${min}–${max} 之间的整数秒，或 null 以恢复继承`);
    patch[name] = value as number | null;
  }
  return patch;
}

async function workspaceOf(project: string, expectedWorkspace: string, root: string): Promise<string> {
  if (!expectedWorkspace) throw Object.assign(new Error("必须明确提供预期工作区目录"),
    { code: "WORKSPACE_SCOPE_REQUIRED", status: 400 });
  const workspace = await workspaceForProject(project, root);
  // Do not resolve the old expected path: a moved directory or replacement
  // symlink must never retarget an existing draft to a different directory.
  if (workspace !== expectedWorkspace) throw Object.assign(new Error("工作区登记目录已变化，请刷新工作区列表后重试"),
    { code: "WORKSPACE_SCOPE_CHANGED", status: 409 });
  return workspace;
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function settingsPath(workspace: string, create = false): Promise<string | null> {
  const directory = join(workspace, ".rsa");
  let parent = await optionalStat(directory);
  if (!parent) {
    if (!create) return null;
    try { await mkdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    parent = await lstat(directory);
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(directory) !== directory)
    throw new Error(".rsa 必须是工作区内的真实目录");
  const path = join(directory, "settings.json"), file = await optionalStat(path);
  if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("settings.json 必须是工作区内的普通文件");
  return path;
}

async function readSettings(workspace: string): Promise<Record<string, unknown>> {
  const path = await settingsPath(workspace);
  if (!path) return {};
  let value: unknown;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { value = JSON.parse(await file.readFile("utf8")); }
    finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作区设置必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function overrides(value: Record<string, unknown>): Partial<PerceptionSettings> {
  const result: Partial<PerceptionSettings> = {};
  for (const key of KEYS) {
    const setting = value[key];
    if (setting === undefined || setting === null) continue;
    // Python accepts positive finite seconds, including custom values outside the UI slider range.
    if (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0)
      throw new Error(`${key} 必须是有限的正数秒`);
    result[key] = setting;
  }
  return result;
}

export async function perceptionSettings(project: string, expectedWorkspace: string, root = globalHome): Promise<Partial<PerceptionSettings>> {
  const workspace = await workspaceOf(project, expectedWorkspace, root);
  // A retry after a lost PUT response must not overtake work already queued in
  // this worker. A rejected write still permits a fresh, independent disk read.
  await writes.get(workspace)?.catch(() => {});
  await workspaceOf(project, expectedWorkspace, root);
  return overrides(await readSettings(workspace));
}

// The shared worker can serve overlapping PUT requests. Serialize the entire read/modify/write.
const writes = new Map<string, Promise<Partial<PerceptionSettings>>>();
export async function updatePerceptionSettings(
  project: string,
  input: unknown,
  expectedWorkspace: string,
  root = globalHome,
): Promise<Partial<PerceptionSettings>> {
  const patch = parsePerceptionPatch(input), workspace = await workspaceOf(project, expectedWorkspace, root);
  const work = (writes.get(workspace) ?? Promise.resolve()).catch(() => {}).then(() => withWorkspaceRegistrationLock(root, project, async () => {
    await workspaceOf(project, expectedWorkspace, root);
    const next = await readSettings(workspace);
    overrides(next);
    for (const key of KEYS) if (Object.hasOwn(patch, key)) {
      if (patch[key] === null) delete next[key];
      else next[key] = patch[key];
    }
    const path = (await settingsPath(workspace, true))!;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await settingsPath(workspace); // Recheck before replacing a file changed during the write.
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return overrides(next);
  }));
  writes.set(workspace, work);
  try { return await work; }
  finally { if (writes.get(workspace) === work) writes.delete(workspace); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
const positiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const safeId = (value: unknown): value is string => typeof value === "string" &&
  /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== "..";

/** Read one live status only. Never starts/reloads a host, sampler, or recorder. */
export async function perceptionRuntime(
  project: string, expectedWorkspace: string, root = globalHome,
): Promise<PerceptionRuntimeSnapshot> {
  const workspace = await workspaceOf(project, expectedWorkspace, root);
  const unavailable = (reason: PerceptionRuntimeSnapshot["reason"]): PerceptionRuntimeSnapshot => ({
    checkedAt: new Date().toISOString(), connection: "unavailable", reason, runId: null, perception: null,
  });
  // Every host owns its canonical address even when RSA_SOCKET adds an alias.
  // Neither the Dashboard environment nor an archived manifest chooses this socket.
  const { socket } = await resolveWorkspaceAddress(workspace);
  let value: unknown;
  try { value = await hostRequest<unknown>(socket, { kind: "status", argv: [] }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(code === "ENOENT" || code === "ECONNREFUSED" ? "not-running"
      : error instanceof SyntaxError ? "invalid-status" : "unresponsive");
  }
  const status = object(value);
  if (!status || !safeId(status.runId)) return unavailable("invalid-status");
  // Match the responding run to the selected workspace; never trust a foreign
  // run or fall back to the latest historical perception_status event.
  const path = join(workspace, "logs", status.runId);
  try {
    if (await realpath(path) !== path) return unavailable("scope-mismatch");
    const manifest = object(JSON.parse(await readFile(join(path, "manifest.json"), "utf8")));
    if (!manifest || manifest.workspaceId !== project || manifest.workspace !== workspace ||
        manifest.runId !== status.runId || manifest.kind === "benchmark") return unavailable("scope-mismatch");
  } catch { return unavailable("scope-mismatch"); }
  await workspaceOf(project, expectedWorkspace, root);
  const base: PerceptionRuntimeSnapshot = {
    checkedAt: new Date().toISOString(), connection: "reachable", runId: status.runId, perception: null,
  };
  if (status.perception === undefined || status.perception === null) return base;
  const perception = object(status.perception);
  const states = ["unimplemented", "loading", "ready", "stopped", "error"] as const;
  if (!perception || !states.includes(perception.state as typeof states[number])) return unavailable("invalid-status");
  const history = object(perception.history);
  const values = history && KEYS.every(key => positiveNumber(history[key])) ? {
    hotSeconds: history.hotSeconds as number,
    videoSegmentSeconds: history.videoSegmentSeconds as number,
    videoIdleSeconds: history.videoIdleSeconds as number,
  } : null;
  const generation = typeof perception.generation === "string" && perception.generation.trim() ? perception.generation : null;
  const pid = positiveNumber(perception.pid) && Number.isSafeInteger(perception.pid) ? perception.pid : null;
  return { ...base, perception: {
    state: perception.state as typeof states[number], generation, pid,
    sampleHz: positiveNumber(perception.sampleHz) ? perception.sampleHz : null,
    values,
    // Stopped/failed workers may retain history in the host's last status.
    // A ready snapshot is evidence at checkedAt, not proof of later liveness.
    valueStatus: !values ? "unavailable" : perception.state === "ready" && generation && pid ? "current" : "last-loaded",
    persistent: typeof history?.persistent === "boolean" ? history.persistent : null,
    ...(typeof perception.error === "string" ? { error: perception.error } : {}),
  } };
}
