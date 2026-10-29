"use client";
import { useEffect, useId, useState, type MouseEvent } from "react";
import {
  benchmarkCommand, benchmarkVerifyCommand, benchmarkSelection, benchmarkRunUrl, compareResults,
  evidenceLabel, parseResultKey, resultKey, taskKey,
  type BenchmarkAttachment, type BenchmarkCatalog, type BenchmarkEvidence, type BenchmarkEvidenceItem, type BenchmarkResult, type TrialSummary,
} from "@/lib/benchmarks";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const number = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const short = (value: string) => value.length > 24 ? value.slice(0, 20) + "…" : value;

/** Keep one page per request and discard late responses after navigation. */
function useBenchmarkRead<T>(url: string | null, refresh = false) {
  const t = useTranslations("benchmarkCases");
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? t("loadFailed"));
        if (!controller.signal.aborted) setLoaded({ url, value });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined, error: String(error) }));
      } finally {
        if (refresh && !controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, refresh, t]);
  return loaded?.url === url ? loaded : null;
}
function detailUrl(key: string | null, verification?: string | null, cursors?: { verification?: string | null; evidence?: string | null }) {
  const identity = parseResultKey(key);
  if (!identity) return null;
  const params = new URLSearchParams(identity);
  if (verification) params.set("verification", verification);
  if (cursors?.verification) params.set("verificationCursor", cursors.verification);
  if (cursors?.evidence) params.set("evidenceCursor", cursors.evidence);
  return "/api/benchmarks?" + params;
}
function Status({ trial, result }: { trial: TrialSummary; result?: BenchmarkResult }) {
  const t = useTranslations("benchmarkCases");
  return <>
    <Badge variant={trial.status === "error" ? "destructive" : "outline"} className={trial.status === "running" ? "border-primary/40 text-primary" : undefined}>{t(`trialStatus.${trial.status}`)}</Badge>
    {result && <Badge variant={result.verification?.status === "error" ? "destructive" : "outline"} className="ml-2">{result.verification ? t(`verificationStatus.${result.verification.status}`) : t("notScored")}</Badge>}
  </>;
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
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onNavigate(eventUrl);
    }}>{t("viewEvidenceRun")}</a><pre>{JSON.stringify(item.event, null, 2)}</pre></>}
    {open && item.available && item.reference.kind === "file" && <>
      {!attachment && <p role="status">{t("readingAttachment")}</p>}
      {attachment?.error && <Alert variant="destructive"><AlertDescription>{attachment.error}</AlertDescription></Alert>}
      {attachment?.value && <><pre>{attachment.value.text}</pre>{attachment.value.truncated && <p className="bench-note">{t("attachmentTruncated")}</p>}</>}
    </>}
    <pre>{JSON.stringify(item.reference, null, 2)}</pre>
  </details>;
}

export function BenchmarkCases({ search, refresh, navigate, onNavigate }: {
  search: string; refresh: boolean; navigate: (patch: Record<string, string | null>) => void; onNavigate: (url: string) => void;
}) {
  const t = useTranslations("benchmarkCases");
  const workspaceId = useId();
  const query = new URLSearchParams(search);
  const [copied, setCopied] = useState("");
  const params = new URLSearchParams({ limit: "25" });
  if (query.get("benchWorkspace")) params.set("project", query.get("benchWorkspace")!);
  if (query.get("case")) params.set("task", query.get("case")!);
  if (query.get("benchCursor")) params.set("cursor", query.get("benchCursor")!);
  const catalogLoad = useBenchmarkRead<BenchmarkCatalog>("/api/benchmarks?" + params, refresh);
  const catalog = catalogLoad?.value;
  const rows = catalog?.history.trials ?? [];
  const selectedKey = query.get("result") ?? (rows[0] ? resultKey(rows[0]) : null);
  const selectedSummary = rows.find(row => resultKey(row) === selectedKey);
  const requestedVerification = query.get("verification") ?? query.get("report") ?? selectedSummary?.selectedVerificationId;
  const selectedLoad = useBenchmarkRead<BenchmarkEvidence>(detailUrl(selectedKey, requestedVerification, {
    verification: query.get("verificationCursor"), evidence: query.get("evidenceCursor"),
  }), refresh);
  const proof = selectedLoad?.value, selected = proof?.result;
  const baselineKey = query.get("baseline");
  const baselineLoad = useBenchmarkRead<BenchmarkEvidence>(detailUrl(baselineKey, query.get("baselineVerification") ?? query.get("baselineReport")));
  const baseline = baselineLoad?.value?.result;
  const comparison = selected && baseline ? compareResults(selected, baseline) : null;
  const workspace = catalog?.projects.find(item => item.id === catalog.project)?.workspace;
  const chosenName = query.get("case") ?? selected?.trial.task.name;
  const chosenDigest = query.get("caseDigest") ?? selected?.trial.task.digest;
  const chosenTask = catalog?.tasks.find(task => task.name === chosenName && (!chosenDigest || task.digest === chosenDigest));
  const reset = { result: null, baseline: null, verification: null, baselineVerification: null, report: null, baselineReport: null,
    verificationCursor: null, evidenceCursor: null, benchCursor: null, caseDigest: null };
  const link = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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

  if (!catalog) return <section className="surface empty-state main-empty" aria-live="polite">
    <h2>{catalogLoad?.error ? t("catalogUnavailable") : t("catalogLoading")}</h2><p>{catalogLoad?.error ?? t("catalogDescription")}</p>
  </section>;
  return <div className="benchmark-cases">
    {catalogLoad.error && <Alert variant="destructive"><AlertDescription>{catalogLoad.error}<small>{t("keepLastPage")}</small></AlertDescription></Alert>}
    {(catalog.issues.length > 0 || catalog.history.issues.length > 0) && <details className="bench-warning"><summary>{t("diagnostics")}</summary>
      {catalog.issues.map((issue, index) => <p key={`catalog:${index}`}><code>{issue.project}</code> · {issue.error}</p>)}
      {catalog.history.issues.map((issue, index) => <p key={`history:${index}`}><code>{issue.runId}</code> · {issue.error}</p>)}
    </details>}
    <div className="bench-toolbar"><div className="flex min-w-0 flex-wrap items-center gap-2"><Label htmlFor={workspaceId}>{t("workspace")}</Label><NativeSelect id={workspaceId} size="sm" wrapperClassName="w-full sm:w-72" aria-label={t("workspaceAria")} value={catalog.project ?? ""}
      onChange={event => navigate({ ...reset, benchWorkspace: event.target.value || null, case: null })}>
      {!catalog.projects.length && <NativeSelectOption value="">{t("noWorkspace")}</NativeSelectOption>}
      {catalog.projects.map(project => <NativeSelectOption key={project.id} value={project.id}>{project.workspace}</NativeSelectOption>)}
    </NativeSelect></div><span className="text-muted-foreground">{t("pageNote")}</span></div>
    <div className="bench-case-layout">
      <aside className="surface bench-case-list" aria-label={t("catalogAria")}><div className="bench-list-heading"><span>{catalog.tasks.length} {t("taskPackages")}</span></div>
        <Button type="button" variant="ghost" className="mb-1 block h-auto w-full whitespace-normal border border-transparent px-3 py-3 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10" aria-pressed={!query.get("case")} onClick={() => navigate({ ...reset, case: null })}>{t("allHistory")}</Button>
        {catalog.tasks.map(task => <Button type="button" variant="ghost" key={taskKey(task)} className="mb-1 flex h-auto w-full flex-col items-start gap-2 whitespace-normal border border-transparent px-3 py-3 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10"
          aria-pressed={chosenTask === task} onClick={() => navigate({ ...reset, case: task.name, caseDigest: task.digest })}>
          <strong>{task.name}</strong>{task.title !== task.name && <span className="text-xs text-muted-foreground">{task.title}</span>}<small className="text-muted-foreground">{task.source === "repository" ? t("repoTask") : t("workspaceTask")} · {task.version ?? task.schemaVersion}</small>
          <span className="flex w-full flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><code>{short(task.digest)}</code>{task.unsupportedRequirements.length > 0 && <Badge variant="destructive">{t("envUnmet")}</Badge>}</span>
        </Button>)}
      </aside>
      <div className="bench-case-main">
        {chosenTask && <section className="surface bench-result">
          <header className="bench-result-heading"><div><h2>{chosenTask.name}</h2>{chosenTask.config.task.description && <p>{chosenTask.config.task.description}</p>}</div></header>
          {workspace && chosenTask.bindings.map(binding => {
            const command = benchmarkCommand(chosenTask, workspace, binding.path)!;
            return <div className="bench-command" key={binding.path}><code>{command}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(command)}>{t("copyRunCommand")}</Button></div>;
          })}
          {copied && <span role="status">{copied}</span>}
          {!chosenTask.bindings.length && <p className="bench-note">{t("noBindings")}</p>}
          {chosenTask.unsupportedRequirements.length > 0 && <div className="bench-warning">{t("envUnsupportedPrefix")}{chosenTask.unsupportedRequirements.join(t("listSeparator"))}</div>}
        </section>}
        <section className="surface bench-history"><div className="surface-heading"><h2>{t("historyTitle")}</h2><span>{rows.length} {t("historySubtitle")}</span></div>
          {rows.length > 0 ? <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top"><TableHeader className="bg-muted/40"><TableRow><TableHead>{t("colTime")}</TableHead><TableHead>{t("colStatus")}</TableHead><TableHead>{t("colVerification")}</TableHead><TableHead>{t("colActions")}</TableHead></TableRow></TableHeader><TableBody>
            {rows.map(trial => <TableRow key={resultKey(trial)} data-state={resultKey(trial) === selectedKey ? "selected" : undefined}>
              <TableCell className="min-w-40"><Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => selectTrial(trial)}>{date(trial.startedAt)}</Button><small className="mt-1 block max-w-64 whitespace-normal text-muted-foreground">{trial.task.name}</small></TableCell>
              <TableCell><Status trial={trial} /></TableCell><TableCell><code>{trial.selectedVerificationId ?? t("notScored")}</code></TableCell>
              <TableCell><Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ baseline: resultKey(trial), baselineVerification: trial.selectedVerificationId ?? null, baselineReport: null })}>{t("setBaseline")}</Button>
                <Button asChild variant="link" size="xs"><a href={benchmarkRunUrl(trial)} onClick={event => link(event, benchmarkRunUrl(trial))}>{t("viewRun")}</a></Button></TableCell>
            </TableRow>)}
          </TableBody></Table> : <p className="bench-note">{t("noHistory")}</p>}
          <div className="bench-selectors">{query.get("benchCursor") && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ benchCursor: null })}>{t("latestPage")}</Button>}
            {catalog.history.nextCursor && <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ benchCursor: catalog.history.nextCursor! })}>{t("olderRuns")}</Button>}</div>
        </section>
        <section className="surface bench-result" aria-label={t("detailAria")}>
          {selectedLoad?.error && <Alert variant="destructive"><AlertDescription>{selectedLoad.error}</AlertDescription></Alert>}
          {selectedKey && !selected && !selectedLoad?.error && <p role="status">{t("readingSelected")}</p>}
          {!selectedKey && <p className="bench-note">{t("selectExecution")}</p>}
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
            {baselineKey && <p className="bench-note">{t("baselinePrefix")}<code>{baselineKey}</code>{baseline?.verification && ` @ ${baseline.verification.id}`} <Button type="button" variant="link" size="xs" className="h-auto whitespace-normal px-0 text-left" onClick={() => navigate({ baseline: null, baselineVerification: null, baselineReport: null })}>{t("remove")}</Button></p>}
            {baselineLoad?.error && <Alert variant="destructive"><AlertDescription>{t("baselineFailedPrefix")}{baselineLoad.error}</AlertDescription></Alert>}
            {baselineKey && !baseline && !baselineLoad?.error && <p role="status">{t("readingBaseline")}</p>}
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
        </section>
      </div>
    </div>
  </div>;
}
