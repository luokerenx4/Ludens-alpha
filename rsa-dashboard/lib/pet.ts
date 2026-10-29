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
  workspace: string | null;
  runId: string | null;
  phase: "idle" | "switching" | "following" | "error";
  error: string | null;
  seenAt: string;
}
export interface PetState {
  target: PetTarget | null;
  consumer: PetConsumer | null;
  connected: boolean;
}
export function workspaceLabel(project?: Pick<Project, "id" | "workspace" | "name">, t?: (key: string) => string): string {
  if (!project) {
    const translated = t?.("unselected");
    return translated && translated !== "unselected" ? translated : "未选择工作区";
  }
  if (project.name) return project.name;
  const parts = project.workspace?.split("/").filter(Boolean);
  return (parts?.at(-1) === "workspace" ? parts.at(-2) : parts?.at(-1)) ?? project.id;
}

export function petStatus(state: PetState | null, t?: (key: string) => string): string {
  const key = !state ? "connecting" : !state.connected ? "disconnected"
    : !state.target ? (state.consumer?.phase === "idle" ? "stopped" : "stopping")
    : state.consumer?.workspace !== state.target.workspace ? "switching"
    : state.consumer.phase === "error" ? "followError"
    : state.consumer.revision !== state.target.revision ? "switching"
    : state.consumer.runId ? "following" : "waitingRun";
  const full = `status.${key}`;
  const translated = t?.(full);
  if (translated && translated !== full) return translated;
  return (!state ? "正在连接…" : !state.connected ? "Ludens Pet 未连接"
    : !state.target ? (state.consumer?.phase === "idle" ? "已停止跟随" : "正在停止…")
    : state.consumer?.workspace !== state.target.workspace ? "正在切换…"
    : state.consumer.phase === "error" ? "跟随遇到问题"
    : state.consumer.revision !== state.target.revision ? "正在切换…"
    : state.consumer.runId ? "正在跟随" : "等待工作区运行");
}
