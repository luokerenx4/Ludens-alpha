import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog, artifactRoot } from "./data";

/** Workspace overrides only; absent values inherit the perception process environment. */
export interface PerceptionSettings {
  hotSeconds: number;
  videoSegmentSeconds: number;
  videoIdleSeconds: number;
}
export type PerceptionSettingsPatch = Partial<{ [K in keyof PerceptionSettings]: number | null }>;

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

async function workspaceOf(project: string, root: string): Promise<string> {
  const indexed = (await catalog(root, true)).find((p) => p.id === project);
  if (!indexed?.workspace) throw new Error("未找到已登记的工作区");
  return indexed.workspace; // catalog resolves the registered workspace's real path.
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

export async function perceptionSettings(project: string, root = artifactRoot): Promise<Partial<PerceptionSettings>> {
  return overrides(await readSettings(await workspaceOf(project, root)));
}

// The shared worker can serve overlapping PUT requests. Serialize the entire read/modify/write.
const writes = new Map<string, Promise<Partial<PerceptionSettings>>>();
export async function updatePerceptionSettings(
  project: string,
  input: unknown,
  root = artifactRoot,
): Promise<Partial<PerceptionSettings>> {
  const patch = parsePerceptionPatch(input), workspace = await workspaceOf(project, root);
  const work = (writes.get(workspace) ?? Promise.resolve()).catch(() => {}).then(async () => {
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
  });
  writes.set(workspace, work);
  try { return await work; }
  finally { if (writes.get(workspace) === work) writes.delete(workspace); }
}
