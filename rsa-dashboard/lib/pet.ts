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
export function workspaceLabel(project?: Pick<Project, "id" | "workspace" | "name">) {
  if (!project) return "未选择工作区";
  if (project.name) return project.name;
  const parts = project.workspace?.split("/").filter(Boolean);
  return (parts?.at(-1) === "workspace" ? parts.at(-2) : parts?.at(-1)) ?? project.id;
}
export function petStatus(state: PetState | null) {
  if (!state) return "正在连接…";
  if (!state.connected) return "Ludens Pet 未连接";
  if (!state.target)
    return state.consumer?.phase === "idle" ? "已停止跟随" : "正在停止…";
  if (state.consumer?.workspace !== state.target.workspace)
    return "正在切换…";
  if (state.consumer.phase === "error") return "跟随遇到问题";
  if (state.consumer.revision !== state.target.revision) return "正在切换…";
  return state.consumer.runId ? "正在跟随" : "等待工作区运行";
}
