import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactRoot, catalog } from "./data";
import type { AliceConsumer, AliceState, AliceTarget } from "./alice";

const targetFile = ".alice-target.json";
const consumerFile = ".alice-consumer.json";
export const ALICE_HEARTBEAT_TTL_MS = 15_000;
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
  mkdirSync(root, { recursive: true });
  const temporary = join(root, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value) + "\n");
  renameSync(temporary, join(root, name));
}
export function aliceState(root = artifactRoot, now = Date.now()): AliceState {
  const target = read<AliceTarget | null>(root, targetFile) ?? null;
  const consumer = read<AliceConsumer>(root, consumerFile) ?? null;
  return {
    target,
    consumer,
    connected: !!consumer && now - Date.parse(consumer.seenAt) < ALICE_HEARTBEAT_TTL_MS &&
      processAlive(consumer.pid),
  };
}
export async function setAliceTarget(
  project: unknown,
  ifUnset = false,
  root = artifactRoot,
): Promise<AliceState> {
  if (project !== null && typeof project !== "string")
    throw new Error("请选择已登记的工作区");
  const indexed = project === null ? null : (await catalog(root, true)).find((p) => p.id === project);
  if (project !== null && !indexed?.workspace)
    throw new Error("未找到已登记的工作区");
  // Null is an explicit choice to stop following. A startup default must not undo it.
  const previous = read<AliceTarget | null>(root, targetFile);
  if (ifUnset && previous !== undefined) return aliceState(root);
  if (previous?.project === project && previous.workspace === indexed?.workspace)
    return aliceState(root);
  write(root, targetFile, indexed ? {
    project: indexed.id,
    workspace: indexed.workspace!,
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  } satisfies AliceTarget : null);
  return aliceState(root);
}
export function recordAliceConsumer(input: unknown, root = artifactRoot): AliceState {
  const value = input as Partial<AliceConsumer> | null;
  if (!value || typeof value.instanceId !== "string" || !value.instanceId || !validPid(value.pid) ||
      !["idle", "switching", "following", "error"].includes(value.phase ?? "") ||
      !["revision", "workspace", "runId", "error"].every((key) =>
        value[key as keyof AliceConsumer] === null || typeof value[key as keyof AliceConsumer] === "string"))
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
  return aliceState(root);
}
