import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { catalog, artifactRoot } from "./data";

/** The perception tuning knobs exposed per workspace; the byte ceiling stays an
 *  environment safety valve and is deliberately not part of this surface. */
export interface PerceptionSettings {
  hotSeconds: number;
  videoSegmentSeconds: number;
  videoIdleSeconds: number;
}

export const PERCEPTION_LIMITS = {
  hotSeconds: { min: 10, max: 3600 },
  videoSegmentSeconds: { min: 10, max: 3600 },
  videoIdleSeconds: { min: 1, max: 600 },
} as const;

function valid(value: unknown, { min, max }: { min: number; max: number }): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`设置值必须是 ${min}–${max} 之间的整数秒`);
  return value;
}

async function workspaceOf(project: string, root: string): Promise<string> {
  const indexed = (await catalog(root, true)).find((p) => p.id === project);
  if (!indexed?.workspace) throw new Error("未找到已登记的工作区");
  return resolve(indexed.workspace);
}

async function settingsPath(project: string, root: string): Promise<string> {
  const settings = join(await workspaceOf(project, root), ".rsa", "settings.json");
  // The catalog lists registered workspaces only; refuse anything that
  // resolves outside the recorded location.
  const parent = join(settings, "..");
  const [settingsStat, parentStat] = await Promise.all([stat(settings).catch(() => null), stat(parent)]);
  if (!parentStat.isDirectory()) throw new Error("工作区缺少 .rsa 目录");
  if (settingsStat?.isDirectory()) throw new Error("settings.json 必须是文件");
  return settings;
}

export async function perceptionSettings(project: string, root = artifactRoot): Promise<Partial<PerceptionSettings>> {
  const path = await settingsPath(project, root);
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作区设置必须是 JSON 对象");
  const result: Partial<PerceptionSettings> = {};
  for (const key of Object.keys(PERCEPTION_LIMITS) as (keyof PerceptionSettings)[]) {
    if (value[key] === undefined) continue;
    valid(value[key], PERCEPTION_LIMITS[key]);
    result[key] = value[key] as number;
  }
  const unknown = Object.keys(value).filter((key) => !(key in PERCEPTION_LIMITS));
  if (unknown.length) throw new Error("未知的工作区设置: " + unknown.join(", "));
  return result;
}

export async function updatePerceptionSettings(
  project: string,
  patch: Partial<PerceptionSettings>,
  root = artifactRoot,
): Promise<Partial<PerceptionSettings>> {
  const current = await perceptionSettings(project, root);
  const next: Partial<PerceptionSettings> = { ...current };
  for (const key of Object.keys(PERCEPTION_LIMITS) as (keyof PerceptionSettings)[]) {
    const value = valid(patch[key], PERCEPTION_LIMITS[key]);
    if (value !== undefined) next[key] = value;
  }
  const path = await settingsPath(project, root);
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n");
  await rename(temporary, path);
  return next;
}
