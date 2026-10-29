import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { globalHome } from "./data";
import { registeredWorkspace, readWorkspaceIdentity, validWorkspaceId, withWorkspaceRegistrationLock, withPetTargetLock } from "../../shared/ludens";
import type { PetConsumer, PetConsumerReceipt, PetState, PetTarget, PetTargetReceipt } from "./pet";

const targetFile = "pet/target.json";
const consumerFile = "pet/consumer.json";
const targetWrites = new Map<string, Promise<void>>();
function queueTargetWrite<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(root), previous = targetWrites.get(key) ?? Promise.resolve();
  const result = previous.then(action);
  // Publish the barrier before any asynchronous registration/target lock wait.
  // A failed write still settles the queue; later reads inspect actual disk state.
  const settled = result.then(() => {}, () => {});
  targetWrites.set(key, settled);
  void settled.then(() => { if (targetWrites.get(key) === settled) targetWrites.delete(key); });
  return result;
}
export const PET_HEARTBEAT_TTL_MS = 15_000;
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
function validConsumer(value: unknown): value is Omit<PetConsumer, "seenAt"> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PetConsumer>;
  return typeof candidate.instanceId === "string" && !!candidate.instanceId && validPid(candidate.pid) &&
    ["idle", "switching", "following", "error"].includes(candidate.phase ?? "") &&
    ["revision", "workspace", "runId", "error"].every(key =>
      candidate[key as keyof PetConsumer] === null || typeof candidate[key as keyof PetConsumer] === "string") &&
    (candidate.targetRevision === undefined || candidate.targetRevision === null || typeof candidate.targetRevision === "string");
}

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
function readTarget(root: string): PetTarget | null | undefined {
  const value = read<unknown>(root, targetFile);
  if (value === undefined || value === null) return value;
  const target = value as Partial<PetTarget>;
  if (typeof value !== "object" || !validWorkspaceId(target.project) ||
      typeof target.workspace !== "string" || !isAbsolute(target.workspace) ||
      typeof target.revision !== "string" || !target.revision ||
      typeof target.updatedAt !== "string" || !Number.isFinite(Date.parse(target.updatedAt)))
    throw new Error("无效的 Ludens Pet 跟随目标");
  return target as PetTarget;
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
async function currentTarget(root: string, now: number): Promise<Pick<PetState, "target" | "targetConfigured" | "targetUnavailable">> {
  const observed = readTarget(root);
  if (!observed) return { target: null, targetConfigured: observed !== undefined };
  const entry = await targetRegistration(observed.project, root);
  if (!entry) return { target: observed, targetConfigured: true, targetUnavailable: true };
  // Ordinary polling remains read-only, including an empty/unwritable pet
  // directory. Only a moved workspace needs a locked target-file update.
  if (entry.workspace === observed.workspace) return { target: observed, targetConfigured: true };
  const resolved = await withPetTargetLock(root, async () => {
    const current = readTarget(root);
    if (!current) return { target: null, targetConfigured: current !== undefined };
    if (current.project !== observed.project || current.revision !== observed.revision) return undefined;
    const latest = await targetRegistration(current.project, root);
    if (!latest) return { target: current, targetConfigured: true, targetUnavailable: true };
    if (latest.workspace === current.workspace) return { target: current, targetConfigured: true };
    const moved = { ...current, workspace: latest.workspace, revision: randomUUID(), updatedAt: new Date(now).toISOString() };
    write(root, targetFile, moved);
    return { target: moved, targetConfigured: true };
  });
  // Another explicit choice superseded the relocation; read that choice after
  // releasing the lock rather than overwriting or returning the stale target.
  return resolved === undefined ? currentTarget(root, now) : resolved;
}
export async function petState(root = globalHome, now?: number): Promise<PetState> {
  // Capture only writes already accepted when this read enters. A request-level
  // timeout cannot let the confirming GET overtake its still-queued mutation.
  await targetWrites.get(resolve(root));
  const observedAt = now ?? Date.now();
  const targetState = await currentTarget(root, observedAt);
  try {
    const value = read<unknown>(root, consumerFile);
    if (value === undefined) return { ...targetState, consumer: null, connected: false };
    if (!validConsumer(value) || typeof (value as PetConsumer).seenAt !== "string" ||
        !Number.isFinite(Date.parse((value as PetConsumer).seenAt))) throw new Error("无效的 Ludens Pet 状态");
    const consumer = value as PetConsumer;
    const age = observedAt - Date.parse(consumer.seenAt);
    return { ...targetState, consumer, connected: age >= 0 && age < PET_HEARTBEAT_TTL_MS && processAlive(consumer.pid) };
  } catch (error) {
    // Reading a consumer is an independent observation. It cannot invalidate a
    // saved selection or prove that the desktop is disconnected.
    return { ...targetState, consumer: null, connected: null,
      consumerError: error instanceof Error ? error.message : String(error) };
  }
}
export async function setPetTarget(
  project: unknown,
  ifUnset = false,
  root = globalHome,
): Promise<PetTargetReceipt> {
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
    return withPetTargetLock(root, async () => {
      // Null is an explicit choice to stop following. Startup must not undo it.
      const previous = readTarget(root);
      if (ifUnset && previous !== undefined) return { target: previous };
      if (previous?.project === project && previous.workspace === indexed?.workspace) return { target: previous };
      const target = indexed ? {
        project: indexed.id, workspace: indexed.workspace,
        revision: randomUUID(), updatedAt: new Date().toISOString(),
      } satisfies PetTarget : null;
      write(root, targetFile, target);
      return { target };
    });
  };
  // A removal and a follow choice serialize around the same registration. A
  // queued follow must re-check it after unlink, never resurrecting stale state.
  return queueTargetWrite(root, () => project === null ? select() : withWorkspaceRegistrationLock(root, project, select));
}
export async function recordPetConsumer(input: unknown, root = globalHome): Promise<PetConsumerReceipt> {
  if (!validConsumer(input)) throw new Error("无效的 Ludens Pet 状态");
  const value = input;
  const consumer: PetConsumer = {
    instanceId: value.instanceId,
    pid: value.pid,
    revision: value.revision,
    ...(value.targetRevision === undefined ? {} : { targetRevision: value.targetRevision }),
    workspace: value.workspace,
    runId: value.runId,
    phase: value.phase,
    error: value.error,
    seenAt: new Date().toISOString(),
  };
  write(root, consumerFile, consumer);
  return { consumer };
}
