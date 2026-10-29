"use client";

import { CheckIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { petStatus, petStatusKey, workspaceLabel, type PetTarget } from "../lib/pet";
import type { Project } from "../lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLocale, useTranslations } from "@/lib/locale";
import { useRetryFocus } from "./use-retry-focus";
import "./pet-settings.css";

export { usePetFollow } from "./use-pet-follow";
import type { PetFollow } from "./use-pet-follow";
export type { PetFollow } from "./use-pet-follow";

const STOP_TARGET = "!stop";

function targetName(target: PetTarget, projects: Project[], t: (key: string) => string) {
  const project = projects.find(project => project.id === target.project && project.workspace === target.workspace);
  return workspaceLabel(project ?? { id: target.project, workspace: target.workspace }, t);
}
function requestedName(project: string | null, projects: Project[], target: PetTarget | null | undefined, t: (key: string) => string) {
  if (project === null) return t("noSavedTarget");
  const known = projects.find(item => item.id === project);
  return known ? workspaceLabel(known, t) : target?.project === project ? targetName(target, projects, t) : project;
}
function TechnicalDetails({ error }: { error: string }) {
  const t = useTranslations("petFollow");
  return <details className="pet-follow-technical"><summary>{t("technicalDetails")}</summary><p>{error}</p></details>;
}

export function PetFollowCard({
  follow, project, projects = [], onSettings,
}: { follow: PetFollow; project?: Project; projects?: Project[]; onSettings(): void }) {
  const t = useTranslations("petFollow");
  const target = follow.state?.target;
  const known = project && !projects.some(item => item.id === project.id) ? [...projects, project] : projects;
  const selected = !!project?.workspace && target?.project === project.id && target.workspace === project.workspace;
  const stale = !!follow.writeError || (!!follow.readError && follow.lastSaved === undefined);
  const observationUnconfirmed = follow.pending || !!follow.readError || !!follow.writeError;
  const status = follow.pending ? t("updating") : observationUnconfirmed ? t("statusUnavailable") : petStatus(follow.state, t);
  const locked = !follow.canWrite || selected || project?.available === false;
  return <div className="pet-follow-card" data-pet-follow="sidebar">
    <Button type="button" variant="ghost" className="pet-follow-heading h-auto w-full justify-start rounded-none border-0 bg-transparent p-0 text-left whitespace-normal hover:bg-transparent" onClick={onSettings} aria-label={t("manageFollow")}>
      <span className="pet-follow-avatar" aria-hidden="true">L</span>
      <span className="pet-follow-heading-copy"><strong>Ludens Pet</strong><small>{t("manageInSettings")} <span aria-hidden="true">↗</span></small></span>
    </Button>
    <p className="pet-follow-saved" title={target?.workspace}>
      {(stale || follow.state?.targetConfigured) && <><span>{t(stale ? "lastKnownPrefix" : "savedPrefix")}</span>{" "}</>}
      <strong>{target ? targetName(target, known, t) : follow.state ? t(follow.state.targetConfigured ? "noSavedTarget" : "noSavedChoice") : t("targetUnknown")}</strong>
    </p>
    <p className="pet-follow-consumer" data-pet-desktop-status>
      <i aria-hidden="true" className={"status-dot " + (!observationUnconfirmed && follow.state?.connected === true ? "online" : "")} />{status}
    </p>
    {project?.workspace && <Button type="button" variant="outline" size="sm" className="pet-follow-action h-auto whitespace-normal aria-disabled:opacity-60"
      aria-disabled={locked} onClick={() => { if (!locked) void follow.follow(project.id); }}>
      {follow.pending ? t("updating") : selected ? t("savedForThis") : t("setFollowTarget")}
    </Button>}
    {follow.pending && follow.requested !== undefined && <p className="pet-follow-feedback" role="status">{t("savingTarget")} {requestedName(follow.requested, known, target, t)}</p>}
    {follow.writeError ? <p className="pet-follow-feedback is-error" role="alert">{t("saveUnconfirmed")}</p>
      : follow.readError && <p className="pet-follow-feedback is-error" role="alert">{t(follow.state ? "showingLastTarget" : "readUnavailable")}</p>}
  </div>;
}

export function PetFollowSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { state, pending, reading, readError, writeError, requested, lastReadAt, lastSaved, canWrite } = follow;
  const t = useTranslations("petFollow");
  const { locale } = useLocale();
  const target = state?.target;
  const options = projects.filter(project => project.workspace);
  const focus = useRetryFocus(reading, readError || writeError);
  const selectedValue = pending && requested !== undefined ? requested ?? STOP_TARGET : target?.project ?? (state?.targetConfigured ? STOP_TARGET : "");
  const knownTarget = target ? targetName(target, projects, t) : state ? t(state.targetConfigured ? "noSavedTarget" : "noSavedChoice") : t("targetUnknown");
  const stale = !!writeError || (!!readError && lastSaved === undefined);
  const observationUnconfirmed = pending || !!readError || !!writeError;
  const statusKey = petStatusKey(state);
  const status = pending ? t("updating") : observationUnconfirmed ? t("statusUnavailable") : petStatus(state, t);
  const currentError = !observationUnconfirmed && statusKey === "followError" ? state?.consumer?.error : null;
  const canRead = !reading && !pending;
  const requestLabel = reading ? "readingStatus" : writeError ? "readSavedTarget" : readError || state?.consumerError ? "retryRead" : "refreshStatus";
  return <Card className="pet-follow-settings gap-0 py-0 shadow-none" data-pet-follow="settings">
    <CardContent ref={focus.target} tabIndex={-1} className="pet-follow-settings-content p-[18px] outline-none max-[480px]:p-3.5" aria-label={t("savedWorkspace")}>
      <div className="pet-follow-selection">
        <div className="pet-follow-selection-label">
          <Label htmlFor="pet-follow-workspace" className="text-sm font-semibold">{t("savedWorkspace")}</Label>
          <p id="pet-follow-help">{t("savedWorkspaceHelp")}</p>
        </div>
        {state ? <div className="pet-follow-selection-control">
          <NativeSelect id="pet-follow-workspace" aria-label={t("followSelectLabel")} aria-describedby="pet-follow-help"
            wrapperClassName="w-full" className="w-full aria-disabled:opacity-60" value={selectedValue}
            aria-disabled={!canWrite}
            onMouseDown={event => { if (!canWrite) event.preventDefault(); }}
            onKeyDown={event => { if (!canWrite && !["Tab", "Escape"].includes(event.key)) event.preventDefault(); }}
            onChange={event => {
              const next = event.currentTarget.value;
              const available = next === STOP_TARGET || options.some(project => project.id === next && project.available !== false);
              if (!canWrite || !available) { event.currentTarget.value = selectedValue; return; }
              void follow.follow(next === STOP_TARGET ? null : next);
            }}>
            {!state.targetConfigured && <NativeSelectOption value="" disabled>{t("chooseWorkspacePlaceholder")}</NativeSelectOption>}
            <NativeSelectOption value={STOP_TARGET}>{t("stopFollow")}</NativeSelectOption>
            {target && !options.some(project => project.id === target.project) &&
              <NativeSelectOption value={target.project} disabled>{knownTarget}{t("currentTargetSuffix")}</NativeSelectOption>}
            {requested && requested !== target?.project && !options.some(project => project.id === requested) &&
              <NativeSelectOption value={requested} disabled>{requestedName(requested, projects, target, t)}</NativeSelectOption>}
            {options.map(project => <NativeSelectOption key={project.id} value={project.id} disabled={project.available === false}>{workspaceLabel(project, t)}</NativeSelectOption>)}
          </NativeSelect>
          <Badge variant="outline" className="pet-follow-save-badge whitespace-normal text-primary max-[480px]:text-[10px]" data-pet-save-status>
            {!pending && !writeError && !stale && state.targetConfigured && <CheckIcon aria-hidden="true" />}
            {t(pending ? "updating" : writeError ? "saveUnconfirmed" : stale ? "lastKnownLabel" : state.targetConfigured ? "savedLabel" : "notConfigured")}
          </Badge>
        </div> : <p className="pet-follow-empty" role="status">{t(readError ? "readUnavailable" : "readingTarget")}</p>}
      </div>
      {pending && requested !== undefined && <p className="pet-follow-saving" role="status">{t("savingTarget")} <strong>{requestedName(requested, projects, target, t)}</strong></p>}
      {target && <details className="pet-follow-path">
        <summary><ChevronRightIcon aria-hidden="true" /><span>{t("workspaceLocation")}</span><span className="pet-follow-path-preview" aria-hidden="true">{target.workspace}</span></summary>
        <p>{target.workspace}</p>
      </details>}
      {state?.targetUnavailable && <Alert><AlertDescription>{t("targetUnavailable")}</AlertDescription></Alert>}
      {writeError && <Alert variant="destructive" data-pet-write-error><AlertDescription>
        <p className="font-medium">{t("saveUnconfirmed")}</p><p>{t("followWriteFailed")}</p>
        <dl className="pet-follow-comparison"><div><dt>{t("lastConfirmed")}</dt><dd>{knownTarget}</dd></div>
          {requested !== undefined && <div><dt>{t("requestedTarget")}</dt><dd>{requestedName(requested, projects, target, t)}</dd></div>}
        </dl>
        <TechnicalDetails error={writeError} />
      </AlertDescription></Alert>}
      {readError && <Alert variant="destructive" data-pet-read-error><AlertDescription>
        <p>{t(lastSaved !== undefined ? "savedAwaitingStatus" : state ? "showingLastTarget" : "readUnavailable")}</p><TechnicalDetails error={readError} />
      </AlertDescription></Alert>}
      <div className="pet-follow-desktop">
        <div><h3>{t("desktopStatus")}</h3><p>{t("desktopStatusHelp")}</p></div>
        <div className="pet-follow-desktop-actions">
          <Badge variant="outline" className="pet-follow-desktop-badge whitespace-normal" data-pet-desktop-status>
            <i aria-hidden="true" className={"status-dot " + (!observationUnconfirmed && state?.connected === true ? "online" : "")} />{status}
          </Badge>
          <Button type="button" variant="outline" size="sm" aria-disabled={!canRead} className="pet-follow-refresh h-auto whitespace-normal text-left aria-disabled:opacity-50" onClick={event => {
            if (!canRead) return;
            focus.remember(event.currentTarget); follow.refresh();
          }}><RefreshCwIcon aria-hidden="true" className={reading ? "motion-safe:animate-spin" : ""} />{t(requestLabel)}</Button>
        </div>
        {lastReadAt !== null && <p className="pet-follow-read-time">{t("lastReadAt")} <time dateTime={new Date(lastReadAt).toISOString()}>{new Date(lastReadAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></p>}
        {!observationUnconfirmed && state?.connected === false && target && <p className="pet-follow-desktop-note">{t("savedAwaitingDesktop")}</p>}
        {lastSaved !== undefined && !observationUnconfirmed && <p className="pet-follow-desktop-note" role="status">{t("savedAwaitingStatus")}</p>}
        {!observationUnconfirmed && state?.consumerError && <Alert variant="destructive"><AlertDescription><p>{t("statusUnavailable")}</p><TechnicalDetails error={state.consumerError} /></AlertDescription></Alert>}
        {currentError && <Alert variant="destructive"><AlertDescription>{currentError}</AlertDescription></Alert>}
      </div>
    </CardContent>
  </Card>;
}
