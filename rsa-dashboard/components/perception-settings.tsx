"use client";

import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/types";
import type { PerceptionSettings, PerceptionSettingsPatch } from "../lib/perception-config";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { useTranslations } from "@/lib/locale";
import { useReadResource } from "./use-read-resource";
import { useRetryFocus } from "./use-retry-focus";

const LIMITS = {
  hotSeconds: { min: 10, max: 3600, fallback: 600 },
  videoSegmentSeconds: { min: 10, max: 3600, fallback: 300 },
  videoIdleSeconds: { min: 1, max: 600, fallback: 10 },
} as const;
const KEYS = Object.keys(LIMITS) as (keyof PerceptionSettings)[];

function formatSeconds(value: number, t: (key: string) => string): string {
  if (value >= 60 && value % 60 === 0) return value % 3600 === 0 ? `${value / 3600} ${t("hours")}` : `${value / 60} ${t("minutes")}`;
  return `${value} ${t("seconds")}`;
}

/** A new workspace gets its own draft and request lifetime. */
export function PerceptionSettingsPanel({ project, projects, ready, catalogError, catalogLoading, onRetryCatalog }: {
  project: string; projects: Project[]; ready: boolean; catalogError?: string; catalogLoading?: boolean; onRetryCatalog(): void;
}) {
  const t = useTranslations("perceptionSettings");
  const target = projects.find((item) => item.id === project);
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);
  return <div ref={catalogFocus.target} className="grid max-w-4xl gap-4" tabIndex={-1} role="region" aria-label={t("title")}>
    {catalogError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1"><p>{t("catalogFailed")}</p><details className="mt-1 text-xs">
        <summary className="cursor-pointer">{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{catalogError}</pre>
      </details></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading} className="aria-disabled:opacity-50"
        onClick={event => { if (!catalogLoading) { catalogFocus.remember(event.currentTarget); onRetryCatalog(); } }}>{t(catalogLoading ? "retrying" : "retryCatalog")}</Button>
    </AlertDescription></Alert>}
    {target?.workspace ? <WorkspacePerceptionSettings key={`${target.id}:${target.workspace}`} project={target.id} />
      : !ready ? <Card><CardContent role="status" className="text-sm text-muted-foreground">{t("loadingWorkspaces")}</CardContent></Card>
        : !catalogError ? <Card><CardHeader>
          <CardTitle role="heading" aria-level={2}>{t("selectWorkspace")}</CardTitle>
          <CardDescription>{t("selectWorkspaceDescription")}</CardDescription>
        </CardHeader></Card> : null}
  </div>;
}

function WorkspacePerceptionSettings({ project }: { project: string }) {
  const t = useTranslations("perceptionSettings");
  const read = useReadResource<Partial<PerceptionSettings>>(`/api/perception-config?project=${encodeURIComponent(project)}`, t("loadFailed"));
  const settings = read.value;
  const [draft, setDraft] = useState<PerceptionSettingsPatch>({});
  const [writeError, setWriteError] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const saving = useRef<AbortController | null>(null);

  useEffect(() => () => saving.current?.abort(), [project]);

  const change = (key: keyof PerceptionSettings, value: number | null) => {
    setDraft(previous => {
      const next = { ...previous };
      if ((value ?? undefined) === settings?.[key]) delete next[key];
      else next[key] = value;
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    if (saving.current || !settings || !Object.keys(draft).length) return;
    const controller = new AbortController();
    saving.current = controller;
    setPending(true);
    setSaved(false);
    setWriteError("");
    read.cancel();
    try {
      const response = await fetch(`/api/perception-config?project=${encodeURIComponent(project)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? t("saveFailed"));
      if (!controller.signal.aborted) {
        read.replace(value);
        setDraft({});
        setSaved(true);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setWriteError(String((cause as Error).message ?? cause));
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (saving.current === controller) saving.current = null;
    }
  };
  const changed = Object.keys(draft).length > 0;

  return <Card className="max-w-4xl" aria-busy={pending || read.loading}>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>{t("title")}</CardTitle>
      <CardDescription>
        {t("saveHintPrefix")}<code>rsa perception reload</code>{t("saveHintSuffix")}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("readOnlyRefreshHint")}</p>
        <Button type="button" variant="outline" size="sm" aria-disabled={pending || read.loading} className="aria-disabled:opacity-50"
          onClick={() => { if (!saving.current && !read.loading) read.retry(); }}>
          {t(read.loading ? "retrying" : read.error ? "retryRead" : "refresh")}
        </Button>
      </div>
      {read.error && <Alert variant="destructive"><AlertDescription>
        <p>{t("loadFailed")}</p><details className="mt-1 text-xs">
          <summary className="cursor-pointer">{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{read.error}</pre>
        </details>{settings && <p className="mt-1">{t("showingCached")}</p>}
      </AlertDescription></Alert>}
      {writeError && <Alert variant="destructive"><AlertDescription><p>{t("saveFailed")}</p><details className="mt-1 text-xs">
        <summary className="cursor-pointer">{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{writeError}</pre>
      </details></AlertDescription></Alert>}
      {!settings ? read.loading && <p className="text-sm text-muted-foreground" role="status">{t("loading")}</p> : KEYS.map(key => {
        const limit = LIMITS[key];
        const value = Object.hasOwn(draft, key) ? draft[key] ?? undefined : settings[key];
        const current = value ?? limit.fallback;
        const custom = current < limit.min || current > limit.max || !Number.isInteger(current);
        return <div key={key} className="space-y-3 border-b border-border pb-5 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id={`perception-${key}-label`} className="text-sm font-medium">{t(`limits.${key}.label`)}</h3>
            <Badge variant="secondary" className="tabular-nums">{value === undefined ? t("inheritSettings") : formatSeconds(value, t)}</Badge>
          </div>
          <Slider min={limit.min} max={limit.max} step={1}
            value={[Math.max(limit.min, Math.min(limit.max, Math.round(current)))]} disabled={pending}
            aria-labelledby={`perception-${key}-label`} aria-describedby={`perception-${key}-help`}
            onValueChange={([value]) => change(key, value)} />
          <p className="text-xs leading-relaxed text-muted-foreground" id={`perception-${key}-help`}>
            {t(`limits.${key}.help`)}{value === undefined && `${t("builtinDefaultPrefix")}${formatSeconds(limit.fallback, t)}${t("builtinDefaultSuffix")}`}
            {custom && t("customValueNote")}
          </p>
          {value !== undefined && <Button type="button" variant="outline" size="sm"
            disabled={pending} onClick={() => change(key, null)}>{t("restoreInherit")}</Button>}
        </div>;
      })}
      {settings && <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={pending || !changed} onClick={() => void save()}>
          {pending ? t("saving") : t("save")}
        </Button>
        {changed && !pending && <p className="text-xs text-muted-foreground" role="status">{t("unsavedChanges")}</p>}
      </div>}
      {saved && <p className="text-sm text-muted-foreground" role="status">{t("savedPrefix")}<code>rsa perception reload</code>{t("savedSuffix")}</p>}
    </CardContent>
  </Card>;
}
