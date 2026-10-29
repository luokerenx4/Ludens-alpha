"use client";

import { useId } from "react";
import { Folder, LoaderCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { workspaceRunLinks, type WorkspaceRunEntry } from "@/lib/workspace-run-entry";

export function WorkspaceRunEmpty({ state, project, workspaceName, benchmarkRun, error, retrying, onRetry, onNavigate }: {
  state: Exclude<WorkspaceRunEntry, "ready">;
  project?: string;
  workspaceName?: string;
  benchmarkRun?: string;
  error: string;
  retrying: boolean;
  onRetry(): void;
  onNavigate(url: string): void;
}) {
  const t = useTranslations("workspaceRunEmpty");
  const { locale } = useLocale();
  const headingId = useId();
  const links = workspaceRunLinks(project, locale, benchmarkRun);
  const loading = state === "loading-catalog";
  const copy = state === "no-run" && benchmarkRun ? "benchmark-only" : state;
  const action = (href: string, label: string, primary = false) => (
    <Button asChild variant={primary ? "default" : "outline"} className="h-auto min-h-9 whitespace-normal py-2">
      <a href={href} onClick={event => {
        if (!isPlainNavigationClick(event)) return;
        event.preventDefault();
        onNavigate(href);
      }}>{label}</a>
    </Button>
  );
  return <Card aria-labelledby={headingId}>
    <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        {loading ? <LoaderCircle className="size-5 animate-spin" /> : <Folder className="size-5" />}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {workspaceName && <p className="break-words text-xs text-muted-foreground">{workspaceName}</p>}
        <div className="space-y-2" role={loading ? "status" : undefined}>
          <h2 id={headingId} className="text-base font-semibold">{t(`${copy}.title`)}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t(`${copy}.description`)}</p>
        </div>
        {state === "catalog-error" && <Alert variant="destructive"><AlertDescription className="break-words">{error}</AlertDescription></Alert>}
        {!loading && <div className="flex flex-wrap gap-2 pt-1">
          {state === "catalog-error" ? <Button type="button" disabled={retrying} onClick={onRetry}>
            <RefreshCw className={retrying ? "animate-spin" : undefined} />{t(retrying ? "retrying" : "retry")}
          </Button> : state === "no-run" && links.capabilities
            ? action(links.capabilities, t("capabilities"), true)
            : action(links.workspaces, t("workspaces"), true)}
          {state === "no-run" && links.benchmark && action(links.benchmark, t("benchmark"))}
          {state !== "catalog-error" && action(links.quickstart, t("quickstart"))}
          {state === "no-run" && action(links.workspaces, t("switchWorkspace"))}
        </div>}
      </div>
    </CardContent>
  </Card>;
}
