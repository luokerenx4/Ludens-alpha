"use client";
import { useState, type MouseEvent } from "react";
import {
  benchmarkCommand, benchmarkVerifyCommand, benchmarkSelection, benchmarkRunUrl, compareResults,
  evidenceLabel, resultKey, taskKey,
  type BenchmarkAttachment, type BenchmarkCatalog, type BenchmarkEvidence, type BenchmarkEvidenceItem, type BenchmarkResult, type TrialSummary,
} from "@/lib/benchmarks";
import { useLocale, useTranslations } from "@/lib/locale";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, ArrowRight, ClipboardList } from "lucide-react";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useRetryFocus } from "./use-retry-focus";
import { useBenchmarkRead } from "./use-benchmark-read";
import { benchmarkDetailUrl as detailUrl, benchmarkGuidanceLinks, benchmarkHistoryState, benchmarkListCommand,
  benchmarkReferenceState, benchmarkTaskHelpCommand, benchmarkWorkspaceState, clearBenchmarkBaseline, clearBenchmarkFilter, clearBenchmarkResult } from "./benchmark-onboarding";

const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const number = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const short = (value: string) => value.length > 24 ? value.slice(0, 20) + "…" : value;

function Status({ trial, result }: { trial: TrialSummary; result?: BenchmarkResult }) {
  const t = useTranslations("benchmarkCases");
  return <>
    <Badge variant={trial.status === "error" ? "destructive" : "outline"} className={trial.status === "running" ? "border-primary/40 text-primary" : undefined}>{t(`trialStatus.${trial.status}`)}</Badge>
    {result && <Badge variant={result.verification?.status === "error" ? "destructive" : "outline"} className="ml-2">{result.verification ? t(`verificationStatus.${result.verification.status}`) : t("notScored")}</Badge>}
  </>;
}
function ReadIssue({ title, error, cached, state }: { title: string; error: string; cached: boolean; state: string }) {
  const t = useTranslations("benchmarkCases");
  return <Alert variant="destructive" data-benchmark-error={state}><AlertTitle>{title}</AlertTitle><AlertDescription>
    <p>{t(cached ? "readFailedCached" : state === "catalog-error" ? "catalogReadFailedDescription" : "readFailedDescription")}</p>
    <details><summary>{t("technicalDetails")}</summary><pre className="whitespace-pre-wrap break-all">{error}</pre></details>
  </AlertDescription></Alert>;
}
function EvidenceDetail({ item, result, onNavigate }: { item: BenchmarkEvidenceItem; result: BenchmarkResult; onNavigate: (url: string) => void }) {
  const t = useTranslations("benchmarkCases");
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ project: result.trial.project, run: result.trial.runId, attachment: String(item.index) });
  if (result.verification) params.set("verification", result.verification.id);
  const attachment = useBenchmarkRead<BenchmarkAttachment>(open && item.available && item.reference.kind === "file" ? "/api/benchmarks?" + params : null);
  const eventUrl = item.event ? benchmarkRunUrl(result.trial, item.event, item.reference) : null;
  return <details className="bench-evidence" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{evidenceLabel(item.reference)}{item.reference.reward && ` · ${item.reference.reward}`}{!item.available && ` · ${t("unavailable")}`}</summary>
    {item.error && <Alert variant="destructive"><AlertDescription>{item.error}</AlertDescription></Alert>}
    {eventUrl && <><a href={eventUrl} onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); onNavigate(eventUrl);
    }}>{t("viewEvidenceRun")}</a><pre>{JSON.stringify(item.event, null, 2)}</pre></>}
    {open && item.available && item.reference.kind === "file" && <>
      {attachment.loading && !attachment.value && <p role="status">{t("readingAttachment")}</p>}
      {attachment.error && <Alert variant="destructive"><AlertDescription>{attachment.error}</AlertDescription></Alert>}
      <Button type="button" size="sm" variant="outline" aria-disabled={attachment.loading} className="aria-disabled:opacity-50"
        onClick={() => { if (!attachment.loading) attachment.retry(); }}>{t(attachment.loading ? "retrying" : "refreshAttachment")}</Button>
      {attachment?.value && <><pre>{attachment.value.text}</pre>{attachment.value.truncated && <p className="bench-note">{t("attachmentTruncated")}</p>}</>}
    </>}
    <pre>{JSON.stringify(item.reference, null, 2)}</pre>
  </details>;
}

export function BenchmarkCases({ search, workspace, ready, refresh, navigate, onNavigate, catalogError, catalogLoading, onRetryCatalog, workspaceAvailable }: {
  search: string; workspace: string; ready: boolean; refresh: boolean; navigate: (patch: Record<string, string | null>) => void; onNavigate: (url: string) => void;
  catalogError: string; catalogLoading: boolean; onRetryCatalog(): void; workspaceAvailable: boolean;
}) {
  const t = useTranslations("benchmarkCases");
  const { locale } = useLocale();
  const query = new URLSearchParams(search);
  const [copied, setCopied] = useState("");
  const params = new URLSearchParams({ project: workspace, limit: "25" });
  if (query.get("case")) params.set("task", query.get("case")!);
  if (query.get("benchCursor")) params.set("cursor", query.get("benchCursor")!);
  const workspaceState = benchmarkWorkspaceState({ ready, workspace, catalogError, available: workspaceAvailable });
  const catalogLoad = useBenchmarkRead<BenchmarkCatalog>(workspaceState === "ready" ? "/api/benchmarks?" + params : null, refresh);
  const catalog = catalogLoad?.value;
  const rows = catalog?.history.trials ?? [];
  const selectedKey = query.get("result") ?? (rows[0] ? resultKey(rows[0]) : null);
  const selectedState = benchmarkReferenceState(selectedKey);
  const selectedSummary = rows.find(row => resultKey(row) === selectedKey);
  const requestedVerification = query.get("verification") ?? query.get("report") ?? selectedSummary?.selectedVerificationId;
  const selectedLoad = useBenchmarkRead<BenchmarkEvidence>(ready ? detailUrl(selectedKey, requestedVerification, {
    verification: query.get("verificationCursor"), evidence: query.get("evidenceCursor"),
  }) : null, refresh);
  const proof = selectedLoad?.value, selected = proof?.result;
  const baselineKey = query.get("baseline");
  const baselineState = benchmarkReferenceState(baselineKey);
  const baselineLoad = useBenchmarkRead<BenchmarkEvidence>(ready ? detailUrl(baselineKey, query.get("baselineVerification") ?? query.get("baselineReport")) : null);
  const baseline = baselineLoad?.value?.result;
  const comparison = selected && baseline ? compareResults(selected, baseline) : null;
  const workspacePath = catalog?.projects.find(item => item.id === workspace)?.workspace;
  const chosenName = query.get("case") ?? selected?.trial.task.name;
  const chosenDigest = query.get("caseDigest") ?? selected?.trial.task.digest;
  const chosenTask = catalog?.tasks.find(task => task.name === chosenName && (!chosenDigest || task.digest === chosenDigest));
  const reset = { result: null, baseline: null, verification: null, baselineVerification: null, report: null, baselineReport: null,
    verificationCursor: null, evidenceCursor: null, benchCursor: null, caseDigest: null };
  const link = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (!isPlainNavigationClick(event)) return;
    event.preventDefault(); onNavigate(url);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(t("copied")); }
    catch { setCopied(t("copyFailed")); }
  };
  const selectTrial = (trial: TrialSummary) => navigate({ result: resultKey(trial), verification: trial.selectedVerificationId ?? null,
    report: null, verificationCursor: null, evidenceCursor: null });
  const rewards = selected?.verifier_result.rewards;
  const rewardKeys = comparison ? comparison.rewards.map(row => row.key) : Object.keys(rewards ?? {}).sort();
  const links = benchmarkGuidanceLinks(workspace, locale);
  const historyState = catalog ? benchmarkHistoryState(catalog, query.get("case"), query.get("benchCursor")) : null;
  const workspaceFocus = useRetryFocus(catalogLoading, catalogError);
  const readFocus = useRetryFocus(catalogLoad.loading, catalogLoad.error);

  const fullGuidance = historyState === "no-tasks" && selectedState === "none" && baselineState === "none";
  const clearSelection = (event: MouseEvent<HTMLButtonElement>, patch: Record<string, string | null>) => {
    const control = event.currentTarget, focused = document.activeElement === control;
    navigate(patch);
    requestAnimationFrame(() => {
      if (focused && !control.isConnected && document.activeElement === document.body) readFocus.target.current?.focus({ preventScroll: true });
    });
  };
  const retryCatalog = (event: MouseEvent<HTMLButtonElement>) => {
    if (catalogLoading) return;
    workspaceFocus.remember(event.currentTarget); onRetryCatalog();
  };
  return <div className="benchmark-cases" tabIndex={-1} ref={node => { workspaceFocus.target.current = node; readFocus.target.current = node; }}>
    {workspaceState === "loading" && <Card data-benchmark-state="workspace-loading"><CardHeader><CardTitle><h2>{t("workspaceLoading")}</h2></CardTitle><CardDescription role="status">{t("workspaceLoadingDescription")}</CardDescription></CardHeader></Card>}
    {(workspaceState === "empty" || workspaceState === "unavailable") && <Card data-benchmark-state={workspaceState === "empty" ? "no-workspace" : "workspace-unavailable"}>
      <CardHeader><CardTitle><h2>{t(workspaceState === "empty" ? "noWorkspace" : "workspaceUnavailable")}</h2></CardTitle>
        <CardDescription>{t(workspaceState === "empty" ? "chooseWorkspace" : "workspaceUnavailableDescription")}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap gap-2"><Button asChild><a href={links.workspaces} onClick={event => link(event, links.workspaces)}>{t("manageWorkspaces")}</a></Button>
        {workspaceState === "empty" ? <Button asChild variant="outline"><a href={links.quickstart} onClick={event => link(event, links.quickstart)}>{t("readQuickstart")}</a></Button> :
          <Button type="button" variant="outline" aria-disabled={catalogLoading} onClick={retryCatalog}>{t(catalogLoading ? "retrying" : "retryWorkspaceCatalog")}</Button>}</CardContent>
    </Card>}
    {catalogError && <Alert variant="destructive" data-benchmark-state="workspace-error"><AlertTitle>{t("workspaceReadFailed")}</AlertTitle><AlertDescription>
      <p>{t(workspace ? "workspaceReadFailedCached" : "workspaceReadFailedDescription")}</p><details><summary>{t("technicalDetails")}</summary><pre className="whitespace-pre-wrap break-all">{catalogError}</pre></details>
      <Button type="button" size="sm" variant="outline" aria-disabled={catalogLoading} onClick={retryCatalog}>{t(catalogLoading ? "retrying" : "retryWorkspaceCatalog")}</Button>
    </AlertDescription></Alert>}
    {workspaceState === "ready" && <div className="bench-toolbar flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground">{t("pageNote")}</span>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoad.loading} className="aria-disabled:opacity-50" onClick={event => {
        if (catalogLoad.loading) return; readFocus.remember(event.currentTarget); catalogLoad.retry();
      }}>{t(catalogLoad.loading ? "retrying" : "refreshHistory")}</Button>
    </div>}
    {workspaceState === "ready" && !catalog && catalogLoad.loading && <Card data-benchmark-state="catalog-loading"><CardHeader><CardTitle><h2>{t("catalogLoading")}</h2></CardTitle><CardDescription role="status">{t("catalogDescription")}</CardDescription></CardHeader></Card>}
    {catalogLoad.error && <ReadIssue title={t("catalogUnavailable")} error={catalogLoad.error} cached={!!catalog} state="catalog-error" />}
    {catalog && (catalog.issues.length > 0 || catalog.history.issues.length > 0) && <details className="bench-warning"><summary>{t("diagnostics")}</summary>
      {catalog.issues.map((issue, index) => <p key={`catalog:${index}`}><code>{issue.project}</code> · {issue.error}</p>)}
      {catalog.history.issues.map((issue, index) => <p key={`history:${index}`}><code>{issue.runId}</code> · {issue.error}</p>)}
    </details>}
    <div className={catalog?.tasks.length ? "bench-case-layout" : "grid min-w-0 gap-4"}>
      {!!catalog?.tasks.length && <aside className="surface bench-case-list" aria-label={t("catalogAria")}><div className="bench-list-heading"><span>{catalog.tasks.length} {t("taskPackages")}</span></div>
        <Button type="button" variant="ghost" className="mb-1 block h-auto w-full whitespace-normal border border-transparent px-3 py-3 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10" aria-pressed={!query.get("case")} onClick={() => navigate({ ...reset, case: null })}>{t("allHistory")}</Button>
        {catalog.tasks.map(task => <Button type="button" variant="ghost" key={taskKey(task)} className="mb-1 flex h-auto w-full flex-col items-start gap-2 whitespace-normal border border-transparent px-3 py-3 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10"
          aria-pressed={!!query.get("case") && chosenTask === task} onClick={() => navigate({ ...reset, case: task.name, caseDigest: task.digest })}>
          <strong>{task.name}</strong>{task.title !== task.name && <span className="text-xs text-muted-foreground">{task.title}</span>}<small className="text-muted-foreground">{task.source === "repository" ? t("repoTask") : t("workspaceTask")} · {task.version ?? task.schemaVersion}</small>
          <span className="flex w-full flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><code>{short(task.digest)}</code>{task.unsupportedRequirements.length > 0 && <Badge variant="destructive">{t("envUnmet")}</Badge>}</span>
        </Button>)}
      </aside>}
      <div className="bench-case-main">
        {fullGuidance && <Card data-benchmark-guidance="first-task" className="border-primary/25">
          <CardHeader className="gap-3"><span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><ClipboardList aria-hidden size={22} /></span>
            <CardTitle><h2>{t("firstTaskTitle")}</h2></CardTitle><CardDescription className="max-w-2xl">{t("firstTaskDescription")}</CardDescription></CardHeader>
          <CardContent className="grid gap-5"><div className="flex flex-wrap gap-2">
            <Button asChild><a href={links.guide} onClick={event => link(event, links.guide)}><BookOpen aria-hidden />{t("readTaskGuide")}</a></Button>
            {links.capabilities && <Button asChild variant="outline"><a href={links.capabilities} onClick={event => link(event, links.capabilities!)}>{t("viewCapabilities")}<ArrowRight aria-hidden /></a></Button>}
          </div><ol className="grid gap-4 border-t pt-4 sm:grid-cols-3">
            {["addTask", "runTerminal", "inspectEvidence"].map((step, index) => <li key={step} className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">{index + 1}</span><div className="space-y-1"><h3 className="text-sm font-medium">{t(`steps.${step}.title`)}</h3><p className="text-xs leading-relaxed text-muted-foreground">{t(`steps.${step}.description`)}</p></div></li>)}
          </ol>{workspacePath && <details className="text-xs text-muted-foreground"><summary>{t("inspectTaskCatalog")}</summary><div className="bench-command mt-3"><code>{benchmarkListCommand(workspacePath)}</code><Button type="button" variant="outline" size="sm" onClick={() => void copy(benchmarkListCommand(workspacePath))}>{t("copyListCommand")}</Button></div></details>}
          </CardContent>
        </Card>}
        {catalog && !catalog.tasks.length && !fullGuidance && <p className="bench-note">{t(catalog.issues.length ? "tasksUnavailable" : "missingTaskPackages")} <a href={links.guide} onClick={event => link(event, links.guide)}>{t("readTaskGuide")}</a></p>}
        {chosenTask && <section className="surface bench-result">
          <header className="bench-result-heading"><div><h2>{chosenTask.name}</h2>{chosenTask.config.task.description && <p>{chosenTask.config.task.description}</p>}</div></header>
          {workspacePath && chosenTask.bindings.map(binding => {
            const command = benchmarkCommand(chosenTask, workspacePath, binding.path)!;
            return <div className="bench-command" key={binding.path}><code>{command}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(command)}>{t("copyRunCommand")}</Button></div>;
          })}
          {!!chosenTask.bindings.length && <p className="bench-note">{t("terminalRunNote")}</p>}
          {!chosenTask.bindings.length && <><p className="bench-note">{t("noBindings")}</p><div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm"><a href={links.guide} onClick={event => link(event, links.guide)}>{t("readTaskGuide")}</a></Button>
            {workspacePath && <Button type="button" variant="outline" size="sm" onClick={() => void copy(benchmarkTaskHelpCommand(workspacePath, chosenTask.name, chosenTask.digest))}>{t("copyTaskHelpCommand")}</Button>}
          </div></>}
          {chosenTask.unsupportedRequirements.length > 0 && <div className="bench-warning">{t("envUnsupportedPrefix")}{chosenTask.unsupportedRequirements.join(t("listSeparator"))}</div>}
        </section>}
        {catalog && <section className="surface bench-history" data-benchmark-state={historyState}>
          <div className="surface-heading"><h2>{t("historyTitle")}</h2><span>{rows.length} {t("historySubtitle")}</span></div>
          {query.get("case") && <div className="flex flex-wrap items-center gap-2 border-b px-4 pb-3 text-xs"><Badge variant="outline" className="max-w-full whitespace-normal break-all">{query.get("case")}</Badge><span className="text-muted-foreground">{t("allTaskVersions")}</span>
            <Button type="button" variant="outline" size="xs" onClick={() => navigate(clearBenchmarkFilter)}>{t("clearTaskFilter")}</Button></div>}
          {rows.length > 0 ? <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top"><TableHeader className="bg-muted/40"><TableRow><TableHead>{t("colTime")}</TableHead><TableHead>{t("colStatus")}</TableHead><TableHead>{t("colVerification")}</TableHead><TableHead>{t("colActions")}</TableHead></TableRow></TableHeader><TableBody>
            {rows.map(trial => <TableRow key={resultKey(trial)} data-state={resultKey(trial) === selectedKey ? "selected" : undefined}>
              <TableCell className="min-w-40"><Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => selectTrial(trial)}>{date(trial.startedAt)}</Button><small className="mt-1 block max-w-64 whitespace-normal text-muted-foreground">{trial.task.name}</small></TableCell>
              <TableCell><Status trial={trial} /></TableCell><TableCell><code>{trial.selectedVerificationId ?? t("notScored")}</code></TableCell>
              <TableCell><Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ baseline: resultKey(trial), baselineVerification: trial.selectedVerificationId ?? null, baselineReport: null })}>{t("setBaseline")}</Button>
                <Button asChild variant="link" size="xs"><a href={benchmarkRunUrl(trial)} onClick={event => link(event, benchmarkRunUrl(trial))}>{t("viewRun")}</a></Button></TableCell>
            </TableRow>)}
          </TableBody></Table> : <div className="space-y-2 px-4 pb-4 text-sm">
            <p className="font-medium">{t(`historyEmpty.${historyState}.title`)}</p><p className="text-xs leading-relaxed text-muted-foreground">{t(`historyEmpty.${historyState}.description`)}</p>
            {historyState === "no-runs" && !chosenTask && catalog.tasks[0] && <Button type="button" size="sm" variant="outline" onClick={() => navigate({ ...reset, case: catalog.tasks[0].name, caseDigest: catalog.tasks[0].digest })}>{t("chooseFirstTask")}</Button>}
          </div>}
          {(query.get("benchCursor") || catalog.history.nextCursor) && <div className="bench-selectors">{query.get("benchCursor") && <Button type="button" variant="outline" size="sm" onClick={() => navigate({ benchCursor: null })}>{t("latestPage")}</Button>}
            {catalog.history.nextCursor && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ benchCursor: catalog.history.nextCursor! })}>{t("olderRuns")}</Button>}</div>}
        </section>}
        {baselineState !== "none" && <section className="surface bench-result" data-benchmark-baseline={baselineState} aria-label={t("baselineTitle")}>
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium">{t("baselineTitle")}</h2><div className="flex flex-wrap gap-2">
            {baselineState === "valid" && <Button type="button" variant="outline" size="sm" aria-disabled={baselineLoad.loading} onClick={() => { if (!baselineLoad.loading) baselineLoad.retry(); }}>{t(baselineLoad.loading ? "retrying" : "refreshBaseline")}</Button>}
            <Button type="button" variant="outline" size="sm" onClick={event => clearSelection(event, clearBenchmarkBaseline)}>{t("clearBaseline")}</Button></div></div>
          <p className="bench-note break-all"><code>{baselineKey}</code>{baseline?.verification && ` @ ${baseline.verification.id}`}</p>
          {baselineState === "invalid" && <Alert variant="destructive" data-benchmark-error="baseline-invalid"><AlertDescription>{t("invalidBaseline")}</AlertDescription></Alert>}
          {baselineLoad.error && <ReadIssue title={t("baselineUnavailable")} error={baselineLoad.error} cached={!!baseline} state="baseline-error" />}
          {baselineLoad.loading && !baseline && <p role="status">{t("readingBaseline")}</p>}
          {baseline && <p className="bench-note">{baseline.trial.task.name} · {date(baseline.trial.startedAt)}</p>}
        </section>}
        {selectedState !== "none" && <section className="surface bench-result" aria-label={t("detailAria")} data-benchmark-selected={selectedState}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium">{t("detailAria")}</h2><div className="flex flex-wrap gap-2">
            {selectedState === "valid" && <Button type="button" variant="outline" size="sm" aria-disabled={selectedLoad.loading} onClick={() => { if (!selectedLoad.loading) selectedLoad.retry(); }}>{t(selectedLoad.loading ? "retrying" : "refreshSelected")}</Button>}
            {query.has("result") && <Button type="button" variant="outline" size="sm" onClick={event => clearSelection(event, clearBenchmarkResult)}>{t("clearSelected")}</Button>}</div></div>
          {selectedState === "invalid" && <Alert variant="destructive" data-benchmark-error="selected-invalid"><AlertDescription>{t("invalidSelected")}</AlertDescription></Alert>}
          {selectedLoad.error && <ReadIssue title={t("selectedUnavailable")} error={selectedLoad.error} cached={!!selected} state="selected-error" />}
          {selectedLoad.loading && !selected && <p role="status">{t("readingSelected")}</p>}
          {selected && <>
            <header className="bench-result-heading"><div><h2>{selected.trial.task.name}</h2><Status trial={selected.trial} result={selected} /></div>
              <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate(benchmarkSelection(selected, baseline))}>{t("pinVersions")}</Button></header>
            <p className="bench-note">{selected.trial.runId} · {date(selected.trial.startedAt)} · {number(selected.trial.durationMs)} ms</p>
            {selected.trial.status === "running" && <p className="bench-note" role="status">{t("stillRunning")}</p>}
            {selected.trial.error && <Alert variant="destructive"><AlertDescription>{t("executionPrefix")}{selected.trial.error.code} · {selected.trial.error.message}</AlertDescription></Alert>}
            {selected.verification?.error && <Alert variant="destructive"><AlertDescription>{t("scoringPrefix")}{selected.verification.error.code} · {selected.verification.error.message}</AlertDescription></Alert>}
            <div className="bench-result-layers"><div><span>{t("execution")}</span><strong>{t(`trialStatus.${selected.trial.status}`)}</strong></div>
              <div><span>{t("scoring")}</span><strong>{selected.verification ? t(`verificationStatus.${selected.verification.status}`) : t("notScored")}</strong><small>{selected.verification?.id ?? t("unsubmitted")}</small></div>
              <div><span>{t("taskVersion")}</span><code>{short(selected.trial.task.digest)}</code></div></div>
            <section className="bench-report"><h3>{t("reportTitle")}</h3><p className="bench-note">{t("rescoreNote")}</p>
              <div className="bench-verification-list">
                {proof!.verifications.verifications.map(verification => <div key={verification.id} className="bench-verification-row">
                  <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" aria-pressed={selected.verification?.id === verification.id}
                    onClick={() => navigate({ verification: verification.id, report: null, evidenceCursor: null })}><code>{verification.id}</code></Button>
                  <Badge variant={verification.status === "error" ? "destructive" : "outline"}>{t(`verificationStatus.${verification.status}`)}</Badge>
                  <small>{date(verification.startedAt)}{verification.reason ? ` · ${verification.reason}` : ""}</small>
                  <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ baseline: resultKey(selected.trial), baselineVerification: verification.id, baselineReport: null })}>{t("setBaseline")}</Button>
                </div>)}
              </div>
              {!proof!.verifications.verifications.length && <p className="bench-note">{t("noVerifications")}</p>}
              <div className="bench-selectors">{query.get("verificationCursor") && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ verificationCursor: null })}>{t("latestScorePage")}</Button>}
                {proof!.verifications.nextCursor && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ verificationCursor: proof!.verifications.nextCursor! })}>{t("olderScores")}</Button>}</div>
              <div className="bench-command"><code>{benchmarkVerifyCommand(selected.trial)}</code><Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => void copy(benchmarkVerifyCommand(selected.trial))}>{t("copyReverify")}</Button></div>
            </section>
            {!!comparison?.changes.length && <p className="bench-note">{t("diffPrefix")}{comparison.changes.join(t("listSeparator"))}{t("diffSuffix")}</p>}
            {comparison?.sameExecution && <p className="bench-note">{t("sameExecution")}</p>}
            {comparison?.subjectsChanged && <p className="bench-note">{t("subjectsChanged")}</p>}
            <h3>Reward</h3>
            {rewardKeys.length ? <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top"><TableHeader className="bg-muted/40"><TableRow><TableHead>{t("colDimension")}</TableHead><TableHead>{t("colCurrent")}</TableHead>{baseline && <><TableHead>{t("colBaseline")}</TableHead><TableHead>{t("colDelta")}</TableHead></>}</TableRow></TableHeader><TableBody>
              {rewardKeys.map(key => { const compared = comparison?.rewards.find(row => row.key === key); return <TableRow key={key}><TableCell>{key}</TableCell><TableCell>{number(rewards?.[key])}</TableCell>
                {baseline && <><TableCell>{number(compared?.baseline)}</TableCell><TableCell>{number(compared?.delta)}</TableCell></>}</TableRow>; })}
            </TableBody></Table> : <p className="bench-note">{rewards === null || rewards === undefined ? t("noScores") : t("emptyReward")}</p>}
            <div className="bench-checks-heading"><h3>{t("evidenceTitle")}</h3><Button asChild variant="link" size="xs"><a href={benchmarkRunUrl(selected.trial)} onClick={event => link(event, benchmarkRunUrl(selected.trial))}>{t("viewOriginalRun")}</a></Button></div>
            {proof!.evidence.items.map(item => <EvidenceDetail key={`${selected.trial.id}:${selected.verification?.id}:${item.index}`} item={item} result={selected} onNavigate={onNavigate} />)}
            {!proof!.evidence.items.length && <p className="bench-note">{t("noEvidence")}</p>}
            <div className="bench-selectors">{query.get("evidenceCursor") && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ evidenceCursor: null })}>{t("firstEvidencePage")}</Button>}
              {proof!.evidence.nextCursor && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ evidenceCursor: proof!.evidence.nextCursor! })}>{t("moreEvidence")}</Button>}</div>
            {selected.trial.parentRunId && <p><a href={benchmarkRunUrl({ project: selected.trial.project, runId: selected.trial.parentRunId })} onClick={event => link(event, benchmarkRunUrl({ project: selected.trial.project, runId: selected.trial.parentRunId! }))}>{t("viewParentRun")}</a></p>}
            {!!selected.trial.limitations?.length && <div className="bench-limitations"><h3>{t("limitationsTitle")}</h3><ul>{selected.trial.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            <details className="bench-provenance"><summary>{t("provenanceTitle")}</summary><pre>{JSON.stringify({ task: selected.trial.task, parameters: selected.trial.parameters,
              conditions: selected.trial.conditions, subjects: selected.trial.subjects, trace: selected.trial.trace, legacy: selected.trial.legacy,
              verification: selected.verification }, null, 2)}</pre>{baseline && <><h3>{t("baselineTitle")}</h3><pre>{JSON.stringify({ task: baseline.trial.task, parameters: baseline.trial.parameters,
                conditions: baseline.trial.conditions, subjects: baseline.trial.subjects, verification: baseline.verification }, null, 2)}</pre></>}</details>
          </>}
        </section>}
        {copied && <p role="status" className="text-sm text-muted-foreground">{copied}</p>}
      </div>
    </div>
  </div>;
}
