/** Application configuration and a rebuildable index; workspace data stays local. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface WorkspaceDefaults {
  model?: string;
  seconds?: number;
  requests?: number;
  compactionThreshold?: number;
  dashboard?: boolean;
  pet?: boolean;
}
export interface LudensConfig { version: 1; workspaceRoot: string; defaults: WorkspaceDefaults }
export interface WorkspaceIdentity { version: 1; id: string; historyIds?: string[] }
export interface WorkspaceRegistration { id: string; workspace: string; name: string; updatedAt: string }
export interface RegisteredWorkspace extends WorkspaceRegistration { available: boolean }

export function ludensHome(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.LUDENS_HOME && !isAbsolute(environment.LUDENS_HOME)) throw new Error("LUDENS_HOME must be an absolute directory");
  return resolve(environment.LUDENS_HOME || join(homedir(), ".ludens"));
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}
function identity(value: unknown): WorkspaceIdentity {
  if (!object(value) || value.version !== 1 || !validWorkspaceId(value.id)) throw new Error("Invalid .rsa/workspace.json identity");
  if (value.historyIds !== undefined && (!Array.isArray(value.historyIds) || !value.historyIds.every(validWorkspaceId))) throw new Error("Invalid workspace history IDs");
  return { version: 1, id: value.id, ...(Array.isArray(value.historyIds) ? { historyIds: [...new Set(value.historyIds as string[])].filter(id => id !== value.id) } : {}) };
}
export function validateGlobalConfig(value: unknown): LudensConfig {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !["version", "workspaceRoot", "defaults"].includes(key))) {
    throw new Error("Ludens config must contain version: 1, workspaceRoot and defaults");
  }
  if (typeof value.workspaceRoot !== "string" || !isAbsolute(value.workspaceRoot)) throw new Error("workspaceRoot must be an absolute directory");
  if (!object(value.defaults)) throw new Error("defaults must be an object");
  for (const [key, setting] of Object.entries(value.defaults)) {
    if (["seconds", "requests", "compactionThreshold"].includes(key)) {
      if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting <= 0) throw new Error(`defaults.${key} must be a positive integer`);
      if (key === "seconds" && setting * 1000 > 2_147_483_647) throw new Error("defaults.seconds exceeds the control timer range");
    } else if (["pet", "dashboard"].includes(key)) {
      if (typeof setting !== "boolean") throw new Error(`defaults.${key} must be boolean`);
    } else if (key === "model") {
      if (typeof setting !== "string" || !setting.trim()) throw new Error("defaults.model must be non-empty");
    } else throw new Error(`Unknown global default: ${key}`);
  }
  return { version: 1, workspaceRoot: resolve(value.workspaceRoot), defaults: { ...value.defaults } };
}
export async function readGlobalConfig(home = ludensHome()): Promise<LudensConfig> {
  try { return validateGlobalConfig(JSON.parse(await readFile(join(home, "config.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, workspaceRoot: resolve(home, "workspaces"), defaults: {} };
  }
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function writeGlobalConfig(config: LudensConfig, home = ludensHome()): Promise<LudensConfig> {
  const validated = validateGlobalConfig(config);
  return withStateLock(join(home, "config.json.lock"), async () => {
    await atomicJson(join(home, "config.json"), validated);
    return validated;
  });
}
/** The lock covers the read as well as the write, so independent edits compose. */
export async function updateGlobalConfig(
  update: (config: LudensConfig) => LudensConfig | Promise<LudensConfig>, home = ludensHome(),
): Promise<LudensConfig> {
  return withStateLock(join(home, "config.json.lock"), async () => {
    const validated = validateGlobalConfig(await update(await readGlobalConfig(home)));
    await atomicJson(join(home, "config.json"), validated);
    return validated;
  });
}
export function readWorkspaceIdentitySync(workspace: string): WorkspaceIdentity {
  return identity(JSON.parse(readFileSync(join(workspace, ".rsa", "workspace.json"), "utf8")));
}
export async function readWorkspaceIdentity(workspace: string): Promise<WorkspaceIdentity> {
  return identity(JSON.parse(await readFile(join(workspace, ".rsa", "workspace.json"), "utf8")));
}
export async function ensureWorkspaceIdentity(workspace: string): Promise<WorkspaceIdentity> {
  const directory = join(workspace, ".rsa"), path = join(directory, "workspace.json");
  try { return await readWorkspaceIdentity(workspace); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true });
  const value: WorkspaceIdentity = { version: 1, id: `ws-${randomUUID()}` };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    // Publish once, atomically, even if two clients open the directory together.
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return await readWorkspaceIdentity(workspace);
  } finally { await unlink(temporary); }
}

function registrationPath(id: string, home: string) {
  if (!validWorkspaceId(id)) throw new Error("Invalid workspace ID");
  return join(home, "registry", `${id}.json`);
}
export async function registeredWorkspace(id: string, home = ludensHome()): Promise<WorkspaceRegistration> {
  const value: unknown = JSON.parse(await readFile(registrationPath(id, home), "utf8"));
  if (!object(value) || value.id !== id || typeof value.workspace !== "string" || !isAbsolute(value.workspace)
    || typeof value.name !== "string" || typeof value.updatedAt !== "string") throw new Error(`Invalid workspace registration: ${id}`);
  return { id, workspace: value.workspace, name: value.name, updatedAt: value.updatedAt };
}

async function removeEmptyLock(path: string) {
  await rmdir(path).catch(error => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  });
}
async function releaseStateLock(path: string, owner: string) {
  // A replacement lock has a different owner filename. Never unlink that file
  // or recursively remove the directory if another process already acquired it.
  await unlink(join(path, owner)).catch(error => { if (error.code !== "ENOENT") throw error; });
  await removeEmptyLock(path);
}
async function recoverStateLock(path: string) {
  const entries = await readdir(path).catch(error => {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    return undefined;
  });
  if (!entries) return;
  if (!entries.length) { await removeEmptyLock(path); return; }
  if (entries.length !== 1) return;
  const owner = entries[0]!, match = /^owner-([1-9][0-9]*)-[0-9a-f-]{36}$/.exec(owner);
  const pid = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return;
  try { process.kill(pid, 0); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
  await releaseStateLock(path, owner);
}
async function withStateLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const pending = await mkdtemp(`${path}.pending-`), owner = `owner-${process.pid}-${randomUUID()}`;
  let acquired = false;
  try {
    await writeFile(join(pending, owner), "", { mode: 0o600 });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await rename(pending, path); acquired = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await recoverStateLock(path);
        if (Date.now() >= deadline) throw new Error(`Ludens state is busy; retry or inspect ${path}`);
        await new Promise(done => setTimeout(done, 20));
      }
    }
    // Publishing a nonempty directory is atomic: a contender never sees an
    // acquired lock without its PID, even if this process exits immediately.
    return await work();
  } finally { await releaseStateLock(acquired ? path : pending, owner); }
}
async function withRegistryLock<T>(home: string, id: string, work: () => Promise<T>): Promise<T> {
  return withStateLock(`${registrationPath(id, home)}.lock`, work);
}
/** Read-only ownership check, also used before starting any workspace service. */
export async function validateWorkspaceRegistration(workspacePath: string, home = ludensHome()): Promise<{ id: string; workspace: string }> {
  const workspace = await realpath(workspacePath);
  const { id } = await readWorkspaceIdentity(workspace);
  const previous = await registeredWorkspace(id, home).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (previous && previous.workspace !== workspace) {
    try {
      const priorPath = await realpath(previous.workspace);
      if (priorPath !== workspace && (await readWorkspaceIdentity(priorPath)).id === id) {
        throw new Error(`Workspace ${id} is already registered at ${previous.workspace}. For an independent copy use rsa workspace open <path> --new-id.`);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { id, workspace };
}
export async function registerWorkspace(workspacePath: string, home = ludensHome()): Promise<WorkspaceRegistration> {
  const workspace = await realpath(workspacePath);
  const { id } = await readWorkspaceIdentity(workspace);
  return withRegistryLock(home, id, async () => {
    if ((await validateWorkspaceRegistration(workspace, home)).id !== id) throw new Error("Workspace identity changed; retry registration");
    const value = { id, workspace, name: basename(workspace), updatedAt: new Date().toISOString() };
    await atomicJson(registrationPath(id, home), value);
    return value;
  });
}
export async function listRegisteredWorkspaces(home = ludensHome()): Promise<RegisteredWorkspace[]> {
  const names = await readdir(join(home, "registry")).catch(error => { if (error.code !== "ENOENT") throw error; return [] as string[]; });
  const result = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
    const value = await registeredWorkspace(name.slice(0, -5), home);
    let available = false;
    try { available = (await readWorkspaceIdentity(await realpath(value.workspace))).id === value.id; }
    catch { /* An unmounted or moved workspace stays registered. */ }
    return { ...value, available };
  }));
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
export async function forgetWorkspace(id: string, home = ludensHome()): Promise<void> {
  await withRegistryLock(home, id, async () => {
    await unlink(registrationPath(id, home)).catch(error => { if (error.code !== "ENOENT") throw error; });
  });
}
/** Explicitly turn a copied directory into a separate workspace; retain its archived history. */
export async function renewWorkspaceIdentity(workspacePath: string, home = ludensHome()): Promise<WorkspaceIdentity> {
  const workspace = await realpath(workspacePath);
  const previous = await readWorkspaceIdentity(workspace);
  const existing = await registeredWorkspace(previous.id, home).catch(error => { if (error.code !== "ENOENT") throw error; });
  const value: WorkspaceIdentity = { version: 1, id: `ws-${randomUUID()}`, historyIds: [...new Set([previous.id, ...previous.historyIds ?? []])] };
  await atomicJson(join(workspace, ".rsa", "workspace.json"), value);
  await unlink(join(workspace, ".rsa", "shiori", "current-session.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (existing?.workspace === workspace) await forgetWorkspace(previous.id, home);
  return value;
}
