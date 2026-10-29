import type { Project } from "./types";

export interface PetTarget {
  project: string;
  workspace: string;
  revision: string;
  updatedAt: string;
}
export interface PetConsumer {
  instanceId: string;
  pid: number;
  revision: string | null;
  /** Selection being attempted; revision still describes the loaded source. */
  targetRevision?: string | null;
  workspace: string | null;
  runId: string | null;
  phase: "idle" | "switching" | "following" | "error";
  error: string | null;
  seenAt: string;
}
export interface PetState {
  target: PetTarget | null;
  /** False only before any choice (including an explicit stop) has been saved. */
  targetConfigured: boolean;
  consumer: PetConsumer | null;
  connected: boolean | null;
  consumerError?: string;
  targetUnavailable?: boolean;
}
export interface PetTargetReceipt { target: PetTarget | null }
export interface PetConsumerReceipt { consumer: PetConsumer }
export function workspaceLabel(project?: Pick<Project, "id" | "workspace" | "name">, t?: (key: string) => string): string {
  if (!project) {
    const translated = t?.("unselected");
    return translated && translated !== "unselected" ? translated : "未选择工作区";
  }
  if (project.name) return project.name;
  const parts = project.workspace?.split("/").filter(Boolean);
  return (parts?.at(-1) === "workspace" ? parts.at(-2) : parts?.at(-1)) ?? project.id;
}

export function petStatusKey(state: PetState | null): string {
  if (!state) return "connecting";
  if (state.connected === null) return "unknown";
  if (!state.connected) return "disconnected";
  if (state.targetUnavailable) return "unavailable";
  const { target, consumer } = state;
  if (!consumer) return "unknown";
  if (!target) return consumer.phase === "idle" ? "stopped" : "stopping";
  if (consumer.workspace !== target.workspace) return "switching";
  // A failing attempt can precede the first loaded snapshot. Its explicit target
  // revision establishes ownership; an old/unscoped error never belongs to a new choice.
  if (consumer.phase === "error") return (consumer.targetRevision ?? consumer.revision) === target.revision ? "followError" : "switching";
  if ((consumer.targetRevision !== undefined && consumer.targetRevision !== target.revision)
    || consumer.revision !== target.revision || consumer.phase !== "following") return "switching";
  return consumer.runId ? "following" : "waitingRun";
}

export function petStatus(state: PetState | null, t?: (key: string) => string): string {
  const key = petStatusKey(state), full = `status.${key}`;
  const translated = t?.(full);
  if (translated && translated !== full) return translated;
  return ({ connecting: "正在读取状态…", unknown: "桌宠状态未知", disconnected: "Ludens Pet 未连接",
    unavailable: "保存的工作区不可用", stopped: "已停止跟随", stopping: "正在停止…", switching: "等待应用选择",
    followError: "跟随遇到问题", following: "正在跟随", waitingRun: "等待工作区运行" } as Record<string, string>)[key];
}
