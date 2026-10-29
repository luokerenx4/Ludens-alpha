"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Project } from "../lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/locale";
import { useRetryFocus } from "./use-retry-focus";
import { usePerceptionSession } from "./use-perception-session";
import { PerceptionField } from "./perception-field";
import { PerceptionRuntimeStatus } from "./perception-runtime-status";
import { PERCEPTION_KEYS, perceptionPatch, perceptionReloadCommand } from "./perception-draft";

export function PerceptionSettingsPanel({ project, projects, ready, catalogError, catalogLoading, onRetryCatalog }: {
  project: string; projects: Project[]; ready: boolean; catalogError?: string; catalogLoading?: boolean; onRetryCatalog(): void;
}) {
  const t = useTranslations("perceptionSettings");
  const target = projects.find(item => item.id === project);
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);
  return <section ref={catalogFocus.target} className="mx-auto grid w-full max-w-6xl gap-5" tabIndex={-1} aria-label={t("title")}>
    <header className="space-y-2"><h1>{t("title")}</h1><p className="text-sm leading-relaxed text-muted-foreground">{t("editorDescription")}</p></header>
    {catalogError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1"><p>{t("catalogFailed")}</p><details className="mt-1 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{catalogError}</pre></details></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading} className="aria-disabled:opacity-50"
        onClick={event => { if (!catalogLoading) { catalogFocus.remember(event.currentTarget); onRetryCatalog(); } }}>{t(catalogLoading ? "retrying" : "retryCatalog")}</Button>
    </AlertDescription></Alert>}
    {target?.workspace ? <WorkspacePerceptionSettings key={JSON.stringify([target.id, target.workspace])} project={target.id} workspace={target.workspace} />
      : !ready ? <Card><CardContent role="status" className="text-sm text-muted-foreground">{t("loadingWorkspaces")}</CardContent></Card>
        : !catalogError ? <Card><CardContent role="status" className="text-sm text-muted-foreground">{t("selectWorkspace")}</CardContent></Card> : null}
  </section>;
}

function WorkspacePerceptionSettings({ project, workspace }: { project: string; workspace: string }) {
  const t = useTranslations("perceptionSettings"), { state, session } = usePerceptionSession(project, workspace);
  const inheritanceNoteId = useId();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (copied === "idle") return; const timer = setTimeout(() => setCopied("idle"), 2500); return () => clearTimeout(timer); }, [copied]);
  const pending = state.writeState === "saving", dirty = Object.keys(state.draft).length > 0;
  const { invalid } = perceptionPatch(state.draft);
  const saveDisabled = !session || !state.settings || pending || !dirty || !!invalid.length || state.writeState === "unconfirmed";
  const command = perceptionReloadCommand(workspace);
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); if (mounted.current) setCopied("done"); }
    catch { if (mounted.current) setCopied("failed"); }
  };
  const saveStatus = state.writeState === "unconfirmed" ? "writeUnconfirmed" : state.writeState === "saving" ? "saving"
    : state.writeState === "matched" ? "savedValuesMatched" : state.writeState === "review" ? "reviewAfterRead"
      : state.writeState === "saved" ? "savedToWorkspace" : !state.settings ? "savedUnknown" : state.reading ? "readingCached" : "savedValuesLoaded";
  return <div className="grid min-w-0 gap-4" data-perception-editor>
    <Card><CardContent data-perception-summary className="grid gap-4 min-[1200px]:grid-cols-2 min-[1200px]:gap-6">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1"><h2 className="text-sm font-semibold">{t("savedSettingsTitle")}</h2>
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">{t(saveStatus)}</p>
          </div>
          <Button type="button" variant="outline" size="sm" aria-disabled={!session || pending || state.reading} className="aria-disabled:opacity-50"
            onClick={() => { if (!pending && !state.reading) void session?.refresh(); }}>{t(state.reading ? "retrying" : state.readError || state.writeState === "unconfirmed" ? "retryRead" : "refresh")}</Button>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{workspace}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("readOnlyRefreshHint")}</p>
        {state.readError && <Alert variant="destructive"><AlertDescription><p>{t("loadFailed")}</p>{state.settings && <p>{t("showingCached")}</p>}
          <details className="mt-2 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{state.readError}</pre></details></AlertDescription></Alert>}
        {state.writeState === "unconfirmed" && <Alert><AlertDescription><p>{t("unconfirmedRecovery")}</p>
          {state.writeError && <details className="mt-2 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 whitespace-pre-wrap break-all">{state.writeError}</pre></details>}</AlertDescription></Alert>}
      </div>
      <div className="min-w-0 border-t pt-4 min-[1200px]:border-t-0 min-[1200px]:border-l min-[1200px]:pt-0 min-[1200px]:pl-6"><PerceptionRuntimeStatus project={project} workspace={workspace}
        settings={pending || state.reading || state.readError || state.writeState === "unconfirmed" ? null : state.settings}
        revision={state.settingsRevision} saving={pending} /></div>
    </CardContent></Card>
    {!state.settings ? <Card><CardContent role="status" className="text-sm text-muted-foreground">{t(state.readError ? "loadFailed" : "loading")}</CardContent></Card>
      : <><p id={inheritanceNoteId} data-perception-inheritance-note className="rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("inheritanceRule")}</p>
        {PERCEPTION_KEYS.map(name => <PerceptionField key={name} name={name} saved={state.settings![name]} draft={state.draft[name]} pending={pending}
          inheritanceNoteId={inheritanceNoteId} onEdit={(mode, raw) => session?.edit(name, mode, raw)} />)}</>}
    <Card className="gap-0" data-perception-draft-bar><CardContent className="space-y-5">
      <div className="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-2"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{t(dirty ? "unsavedChanges" : "noDraft")}</h2>
          {dirty && <Badge variant="outline">{Object.keys(state.draft).length} {t("changedFields")}</Badge>}</div>
          <p className="text-xs leading-relaxed text-muted-foreground" role="status">{t(state.persistence === "session" ? "draftKeptInTab" : "draftMemoryOnly")}</p>
          {invalid.length > 0 && <p className="text-xs text-destructive">{t("fixInvalidBeforeSave")}</p>}
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto"><Button type="button" variant="outline" aria-disabled={!dirty || pending} className="aria-disabled:opacity-50"
          onClick={() => { if (dirty && !pending) session?.discard(); }}>{t("discardDraft")}</Button>
          <Button type="button" aria-disabled={saveDisabled} className="aria-disabled:opacity-50" onClick={() => { if (!saveDisabled) void session?.save(); }}>{t(pending ? "saving" : "save")}</Button></div>
      </div>
      <div className="space-y-3 border-t pt-5"><h2 className="text-sm font-semibold">{t("applyTitle")}</h2><p className="text-xs leading-relaxed text-muted-foreground">{t("applyDescription")}</p>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/50 p-3"><code className="min-w-0 flex-1 basis-64 select-all break-all text-xs" data-perception-command>{command}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied === "done" ? <Check /> : <Copy />}{t(copied === "done" ? "copiedCommand" : "copyCommand")}</Button></div>
        {copied === "failed" && <p role="alert" className="text-xs text-destructive">{t("copyFailed")}</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">{t("applyDoesNotSave")}</p>
      </div>
    </CardContent></Card>
  </div>;
}
