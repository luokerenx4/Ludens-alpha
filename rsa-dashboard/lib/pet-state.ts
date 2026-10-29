import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalHome, catalog } from "./data";
import { listRegisteredWorkspaces } from "../../shared/ludens";
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
export async function petState(root = globalHome, now = Date.now()): Promise<PetState> {
  let target = read<PetTarget | null>(root, targetFile) ?? null;
  if (target) {
    const entry = (await listRegisteredWorkspaces(root)).find(entry => entry.id === target!.project);
    if (!entry?.available) target = null;
    else if (entry.workspace !== target.workspace) {
      target = { ...target, workspace: entry.workspace, revision: randomUUID(), updatedAt: new Date(now).toISOString() };
      write(root, targetFile, target);
    }
  }
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
  const indexed = project === null ? null : (await catalog(root, true)).find((p) => p.id === project);
  if (project !== null && !indexed?.workspace)
    throw new Error("未找到已登记的工作区");
  // Null is an explicit choice to stop following. A startup default must not undo it.
  const previous = read<PetTarget | null>(root, targetFile);
  if (ifUnset && previous !== undefined) return petState(root);
  if (previous?.project === project && previous.workspace === indexed?.workspace)
    return petState(root);
  write(root, targetFile, indexed ? {
    project: indexed.id,
    workspace: indexed.workspace!,
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  } satisfies PetTarget : null);
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
