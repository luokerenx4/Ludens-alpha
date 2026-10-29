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
import { useTranslations } from "@/lib/locale";
import { useRetryFocus } from "./use-retry-focus";
import "./pet-settings.css";

async function request(fallback: string, init?: RequestInit): Promise<PetState> {
  const response = await fetch("/api/pet", { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? fallback);
  return value;
}

/** One poller per console, shared by the sidebar and settings. Browsing never changes the target. */
export function usePetFollow() {
  const t = useTranslations("petFollow");
  const [state, setState] = useState<PetState | null>(null);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<"read" | "write">("read");
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(true);
  const [revision, setRevision] = useState(0);
  const version = useRef(0), busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      setReading(true);
      const started = version.current;
      try {
        const value = await request(t("connectFailed"), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!controller.signal.aborted && started === version.current && !busy.current) {
          setState(value);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted && started === version.current && !busy.current) { setError(String(e)); setErrorKind("read"); }
      } finally {
        if (!controller.signal.aborted) { setReading(false); timer = setTimeout(poll, 2500); }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision, t]);
  const follow = async (project: string | null) => {
    if (busy.current) return;
    busy.current = true;
    version.current++;
    setPending(true);
    setError("");
    try {
      const next = await request(t("connectFailed"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8000),
      });
      version.current++;
      if (mounted.current) setState(next);
    } catch (e) {
      version.current++;
      if (mounted.current) { setError(String(e)); setErrorKind("write"); }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { state, pending, reading, error, errorKind, follow, refresh: () => { if (!busy.current) setRevision(value => value + 1); } };
}
export type PetFollow = ReturnType<typeof usePetFollow>;

export function PetFollowCard({
  follow, project, onSettings,
}: { follow: PetFollow; project?: Project; onSettings(): void }) {
  const t = useTranslations("petFollow");
  const target = follow.state?.target;
  const selected = !!project?.workspace && target?.project === project.id;
  return <div className="pet-follow-card">
    <Button type="button" variant="ghost" className="pet-follow-heading h-auto w-full justify-start gap-2.5 rounded-none border-0 bg-transparent p-0 text-left whitespace-normal hover:bg-transparent" onClick={onSettings} aria-label={t("manageFollow")}>
      <span className="pet-follow-avatar" aria-hidden="true">L</span>
      <span><strong>Ludens Pet</strong><small>
        <i className={"status-dot " + (follow.state?.connected ? "online" : "")} />
        {follow.error ? t("connectionIssue") : petStatus(follow.state, t)}
      </small></span>
      <span aria-hidden="true">↗</span>
    </Button>
    <p title={target?.workspace}>{target ? workspaceLabel({ id: target.project, workspace: target.workspace }, t) : !follow.state ? t("targetUnknown") : t("noFollowTarget")}</p>
    {project?.workspace ? <Button type="button" variant="outline" size="sm" className="pet-follow-action h-auto px-1.5 py-2 text-[11px] whitespace-normal max-[680px]:px-3"
      disabled={follow.pending || !follow.state || selected}
      onClick={() => void follow.follow(project.id)}>
      {follow.pending ? t("updating") : selected ? t("followingThis") : t("followThis")}
    </Button> : <Button type="button" variant="outline" size="sm" className="pet-follow-action h-auto px-1.5 py-2 text-[11px] whitespace-normal max-[680px]:px-3" onClick={onSettings}>{t("chooseWorkspace")}</Button>}
    {follow.error && <small className="mt-2 block text-xs leading-relaxed text-destructive" role="alert">{t("updateFailedRetry")}</small>}
  </div>;
}

export function PetFollowSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { state, pending, reading, error, errorKind } = follow;
  const t = useTranslations("petFollow");
  const target = state?.target;
  const options = projects.filter((project) => project.workspace);
  const focus = useRetryFocus(reading, error);
  return <Card>
    <CardHeader>
      <CardTitle role="heading" aria-level={3}>{t("followTargetTitle")}</CardTitle>
      <CardDescription>{t("followTargetDescription")}</CardDescription>
    </CardHeader>
    <CardContent ref={focus.target} tabIndex={-1} className="space-y-4 outline-none" aria-label={t("followTargetTitle")}>
      <div className="flex flex-wrap items-center gap-3" role="status">
        <Badge variant="outline" className="gap-2">
          <i className={"status-dot " + (state?.connected ? "online" : "")} />
          {error ? t("connectionIssue") : petStatus(state, t)}
        </Badge>
        <span className="min-w-0 break-all text-sm text-muted-foreground">
          {target ? workspaceLabel({ id: target.project, workspace: target.workspace }, t) : !state ? t("targetUnknown") : t("followingNone")}
        </span>
      </div>
      {state ? <div className="flex flex-col gap-3">
        <div className="space-y-1">
          <Label htmlFor="pet-follow-workspace">{t("followLabel")}</Label>
          <p id="pet-follow-help" className="text-xs leading-relaxed text-muted-foreground">{t("followHelp")}</p>
        </div>
        <NativeSelect id="pet-follow-workspace" aria-label={t("followSelectLabel")} aria-describedby="pet-follow-help"
          wrapperClassName="w-full" className="w-full" value={target?.project ?? ""}
          disabled={pending || !state} onChange={(event) => void follow.follow(event.target.value || null)}>
          <NativeSelectOption value="">{t("stopFollow")}</NativeSelectOption>
          {target && !options.some((project) => project.id === target.project) &&
            <NativeSelectOption value={target.project}>{workspaceLabel({ id: target.project, workspace: target.workspace }, t)}{t("currentTargetSuffix")}</NativeSelectOption>}
          {options.map((project) => <NativeSelectOption key={project.id} value={project.id}>{workspaceLabel(project, t)}</NativeSelectOption>)}
        </NativeSelect>
      </div> : <p className="text-xs leading-relaxed text-muted-foreground" role="status">{t(error ? "readUnavailable" : "readingTarget")}</p>}
      {target && <p className="text-xs leading-relaxed break-all text-muted-foreground">{target.workspace}</p>}
      {state && !state.connected && <p className="text-xs leading-relaxed text-muted-foreground">{t("desktopNotConnected")}</p>}
      {state?.connected && target && state.consumer?.workspace === target.workspace && state.consumer.error &&
        <Alert variant="destructive"><AlertDescription>{state.consumer.error}</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertDescription>
        <p>{t(errorKind === "write" ? "followWriteFailed" : state ? "showingLastTarget" : "readUnavailable")}</p>
        <details className="text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{error}</p></details>
        <Button type="button" variant="outline" size="sm" aria-disabled={reading || pending} className="aria-disabled:opacity-50" onClick={event => {
          if (reading || pending) return;
          focus.remember(event.currentTarget); follow.refresh();
        }}>{t(reading ? "readingTarget" : "retryRead")}</Button>
      </AlertDescription></Alert>}
    </CardContent>
  </Card>;
}
