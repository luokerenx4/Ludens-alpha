"use client";

import { useEffect, useRef, useState } from "react";
import { petStatus, workspaceLabel, type PetState } from "../lib/pet";
import type { Project } from "../lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
    <Button variant="ghost" className="pet-follow-heading h-auto w-full justify-start gap-2.5 rounded-none border-0 bg-transparent p-0 text-left whitespace-normal hover:bg-transparent" onClick={onSettings} aria-label="管理 Ludens Pet 跟随">
      <span className="pet-follow-avatar" aria-hidden="true">L</span>
      <span><strong>Ludens Pet</strong><small>
        <i className={"status-dot " + (follow.state?.connected ? "online" : "")} />
        {follow.error ? "连接遇到问题" : petStatus(follow.state)}
      </small></span>
      <span aria-hidden="true">↗</span>
    </Button>
    <p title={target?.workspace}>{target ? workspaceLabel({ id: target.project, workspace: target.workspace }) : "尚未关注工作区"}</p>
    {project?.workspace ? <Button variant="outline" size="sm" className="pet-follow-action h-auto px-1.5 py-2 text-[11px] whitespace-normal max-[680px]:px-3"
      disabled={follow.pending || !follow.state || selected}
      onClick={() => void follow.follow(project.id)}>
      {follow.pending ? "正在更新…" : selected ? "已关注此工作区" : "让 Ludens Pet 跟随此工作区"}
    </Button> : <Button variant="outline" size="sm" className="pet-follow-action h-auto px-1.5 py-2 text-[11px] whitespace-normal max-[680px]:px-3" onClick={onSettings}>选择关注的工作区</Button>}
    {follow.error && <small className="mt-2 block text-xs leading-relaxed text-destructive" role="alert">无法更新 Ludens Pet 状态，请到 Ludens Pet 页面重试。</small>}
  </div>;
}

export function PetFollowSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { state, pending, error } = follow;
  const target = state?.target;
  const options = projects.filter((project) => project.workspace);
  return <Card>
    <CardHeader>
      <CardTitle role="heading" aria-level={3}>关注的工作区</CardTitle>
      <CardDescription>Ludens Pet 持续跟随这里的最新运行。你可以自由浏览其他工作区和历史记录。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-center gap-3" role="status">
        <Badge variant="outline" className="gap-2">
          <i className={"status-dot " + (state?.connected ? "online" : "")} />
          {error ? "连接遇到问题" : petStatus(state)}
        </Badge>
        <span className="min-w-0 break-all text-sm text-muted-foreground">
          {target ? workspaceLabel({ id: target.project, workspace: target.workspace }) : "未关注任何工作区"}
        </span>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Label htmlFor="pet-follow-workspace">让 Ludens Pet 跟随</Label>
          <p id="pet-follow-help" className="text-xs leading-relaxed text-muted-foreground">切换展示内容，不改变 AI 的接管状态。</p>
        </div>
        <NativeSelect id="pet-follow-workspace" aria-label="Ludens Pet 关注的工作区" aria-describedby="pet-follow-help"
          wrapperClassName="w-full sm:max-w-80" className="w-full" value={target?.project ?? ""}
          disabled={pending || !state} onChange={(event) => void follow.follow(event.target.value || null)}>
          <NativeSelectOption value="">停止跟随</NativeSelectOption>
          {target && !options.some((project) => project.id === target.project) &&
            <NativeSelectOption value={target.project}>{workspaceLabel({ id: target.project, workspace: target.workspace })}（当前目标）</NativeSelectOption>}
          {options.map((project) => <NativeSelectOption key={project.id} value={project.id}>{workspaceLabel(project)}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {target && <p className="text-xs leading-relaxed break-all text-muted-foreground">{target.workspace}</p>}
      {state && !state.connected && <p className="text-xs leading-relaxed text-muted-foreground">Ludens Pet 桌面应用尚未连接。选择会保留，打开 Ludens Pet 后自动生效。</p>}
      {state?.connected && target && state.consumer?.workspace === target.workspace && state.consumer.error &&
        <Alert variant="destructive"><AlertDescription>{state.consumer.error}</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </CardContent>
  </Card>;
}
