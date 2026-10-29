"use client";

import { useEffect, useRef, useState } from "react";
import { petStatus, workspaceLabel, type PetState } from "../lib/pet";
import type { Project } from "../lib/types";
import "./pet-settings.css";

async function request(init?: RequestInit): Promise<PetState> {
  const response = await fetch("/api/pet", { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "无法连接 Ludens Pet");
  return value;
}

/** One poller per console, shared by the sidebar and settings. Browsing never changes the target. */
export function usePetFollow() {
  const [state, setState] = useState<PetState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const version = useRef(0), busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const started = version.current;
      try {
        const value = await request({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!controller.signal.aborted && started === version.current && !busy.current) {
          setState(value);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted && started === version.current) setError(String(e));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const follow = async (project: string | null) => {
    if (busy.current) return;
    busy.current = true;
    version.current++;
    setPending(true);
    setError("");
    try {
      setState(await request({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8000),
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { state, pending, error, follow };
}
export type PetFollow = ReturnType<typeof usePetFollow>;

export function PetFollowCard({
  follow, project, onSettings,
}: { follow: PetFollow; project?: Project; onSettings(): void }) {
  const target = follow.state?.target;
  const selected = !!project?.workspace && target?.project === project.id;
  return <div className="pet-follow-card">
    <button className="pet-follow-heading" onClick={onSettings} aria-label="管理 Ludens Pet 跟随">
      <span className="pet-follow-avatar" aria-hidden="true">L</span>
      <span><strong>Ludens Pet</strong><small>
        <i className={"status-dot " + (follow.state?.connected ? "online" : "")} />
        {follow.error ? "连接遇到问题" : petStatus(follow.state)}
      </small></span>
      <span aria-hidden="true">↗</span>
    </button>
    <p title={target?.workspace}>{target ? workspaceLabel({ id: target.project, workspace: target.workspace }) : "尚未关注工作区"}</p>
    {project?.workspace ? <button className="control-button pet-follow-action"
      disabled={follow.pending || !follow.state || selected}
      onClick={() => void follow.follow(project.id)}>
      {follow.pending ? "正在更新…" : selected ? "已关注此工作区" : "让 Ludens Pet 跟随此工作区"}
    </button> : <button className="control-button pet-follow-action" onClick={onSettings}>选择关注的工作区</button>}
    {follow.error && <small className="setting-error" role="alert">无法更新 Ludens Pet 状态，请到 Ludens Pet 页面重试。</small>}
  </div>;
}

export function PetFollowSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { state, pending, error } = follow;
  const target = state?.target;
  const options = projects.filter((project) => project.workspace);
  return <section className="setting-group pet-follow-settings">
    <header><h3>关注的工作区</h3><p>Ludens Pet 持续跟随这里的最新运行。你可以自由浏览其他工作区和历史记录。</p></header>
    <div className="pet-follow-status" role="status">
      <i className={"status-dot " + (state?.connected ? "online" : "")} />
      <strong>{error ? "连接遇到问题" : petStatus(state)}</strong>
      <span>{target ? workspaceLabel({ id: target.project, workspace: target.workspace }) : "未关注任何工作区"}</span>
    </div>
    <label className="setting-row">
      <span className="setting-label">让 Ludens Pet 跟随<small>切换展示内容，不改变 AI 的接管状态。</small></span>
      <select aria-label="Ludens Pet 关注的工作区" value={target?.project ?? ""}
        disabled={pending || !state} onChange={(event) => void follow.follow(event.target.value || null)}>
        <option value="">停止跟随</option>
        {target && !options.some((project) => project.id === target.project) &&
          <option value={target.project}>{workspaceLabel({ id: target.project, workspace: target.workspace })}（当前目标）</option>}
        {options.map((project) => <option key={project.id} value={project.id}>{workspaceLabel(project)}</option>)}
      </select>
    </label>
    {target && <p className="setting-help pet-target-path">{target.workspace}</p>}
    {state && !state.connected && <p className="setting-help">Ludens Pet 桌面应用尚未连接。选择会保留，打开 Ludens Pet 后自动生效。</p>}
    {state?.connected && target && state.consumer?.workspace === target.workspace && state.consumer.error &&
      <p className="setting-error" role="alert">{state.consumer.error}</p>}
    {error && <p className="setting-error" role="alert">{error}</p>}
  </section>;
}
