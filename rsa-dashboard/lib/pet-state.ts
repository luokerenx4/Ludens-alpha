import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { globalHome } from "./data";
import { registeredWorkspace, readWorkspaceIdentity, validWorkspaceId, withWorkspaceRegistrationLock, withPetTargetLock } from "../../shared/ludens";
import type { PetConsumer, PetState, PetTarget } from "./pet";

const targetFile = "pet/target.json";
const consumerFile = "pet/consumer.json";
export const PET_HEARTBEAT_TTL_MS = 15_000;
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;

function processAlive(pid: number) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read<T>(root: string, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(root, name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function write(root: string, name: string, value: unknown) {
  mkdirSync(join(root, "pet"), { recursive: true });
  const temporary = join(root, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value) + "\n");
  renameSync(temporary, join(root, name));
}
async function targetRegistration(project: string, root: string) {
  const entry = await registeredWorkspace(project, root).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (!entry) return null;
  try { if ((await readWorkspaceIdentity(await realpath(entry.workspace))).id === entry.id) return entry; }
  catch { /* Offline workspaces stay registered. */ }
  return null;
}
async function currentTarget(root: string, now: number): Promise<PetTarget | null> {
  const observed = read<PetTarget | null>(root, targetFile) ?? null;
  if (!observed) return null;
  const entry = await targetRegistration(observed.project, root);
  if (!entry) return null;
  // Ordinary polling remains read-only, including an empty/unwritable pet
  // directory. Only a moved workspace needs a locked target-file update.
  if (entry.workspace === observed.workspace) return observed;
  const resolved = await withPetTargetLock(root, async () => {
    const current = read<PetTarget | null>(root, targetFile) ?? null;
    if (!current) return null;
    if (current.project !== observed.project || current.revision !== observed.revision) return undefined;
    const latest = await targetRegistration(current.project, root);
    if (!latest) return null;
    if (latest.workspace === current.workspace) return current;
    const moved = { ...current, workspace: latest.workspace, revision: randomUUID(), updatedAt: new Date(now).toISOString() };
    write(root, targetFile, moved);
    return moved;
  });
  // Another explicit choice superseded the relocation; read that choice after
  // releasing the lock rather than overwriting or returning the stale target.
  return resolved === undefined ? currentTarget(root, now) : resolved;
}
export async function petState(root = globalHome, now = Date.now()): Promise<PetState> {
  const target = await currentTarget(root, now);
  const consumer = read<PetConsumer>(root, consumerFile) ?? null;
  return {
    target,
    consumer,
    connected: !!consumer && now - Date.parse(consumer.seenAt) < PET_HEARTBEAT_TTL_MS &&
      processAlive(consumer.pid),
  };
}
export async function setPetTarget(
  project: unknown,
  ifUnset = false,
  root = globalHome,
): Promise<PetState> {
  if (project !== null && typeof project !== "string")
    throw new Error("请选择已登记的工作区");
  if (project !== null && !validWorkspaceId(project)) throw new Error("未找到已登记的工作区");
  const select = async () => {
    const indexed = project === null ? null : await registeredWorkspace(project, root).catch(error => {
      if (error.code !== "ENOENT") throw error;
      throw new Error("未找到已登记的工作区");
    });
    if (indexed) {
      const identity = await readWorkspaceIdentity(await realpath(indexed.workspace)).catch(() => null);
      if (identity?.id !== indexed.id) throw new Error("未找到已登记的工作区");
    }
    await withPetTargetLock(root, async () => {
      // Null is an explicit choice to stop following. Startup must not undo it.
      const previous = read<PetTarget | null>(root, targetFile);
      if (ifUnset && previous !== undefined) return;
      if (previous?.project === project && previous.workspace === indexed?.workspace) return;
      write(root, targetFile, indexed ? {
        project: indexed.id, workspace: indexed.workspace,
        revision: randomUUID(), updatedAt: new Date().toISOString(),
      } satisfies PetTarget : null);
    });
  };
  // A removal and a follow choice serialize around the same registration. A
  // queued follow must re-check it after unlink, never resurrecting stale state.
  if (project === null) await select();
  else await withWorkspaceRegistrationLock(root, project, select);
  return petState(root);
}
export async function recordPetConsumer(input: unknown, root = globalHome): Promise<PetState> {
  const value = input as Partial<PetConsumer> | null;
  if (!value || typeof value.instanceId !== "string" || !value.instanceId || !validPid(value.pid) ||
      !["idle", "switching", "following", "error"].includes(value.phase ?? "") ||
      !["revision", "workspace", "runId", "error"].every((key) =>
        value[key as keyof PetConsumer] === null || typeof value[key as keyof PetConsumer] === "string"))
    throw new Error("无效的 Ludens Pet 状态");
  write(root, consumerFile, {
    instanceId: value.instanceId,
    pid: value.pid,
    revision: value.revision,
    workspace: value.workspace,
    runId: value.runId,
    phase: value.phase,
    error: value.error,
    seenAt: new Date().toISOString(),
  });
  return petState(root);
}
