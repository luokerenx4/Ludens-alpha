"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { BarChart3, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "@/lib/locale";
import type { Call, RunData } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { bytes, clockTime, percent, requestBytes, RequestChart, RequestDetails, seconds, transport } from "./run-visuals";

export interface RunAnalysisProps {
  data: RunData;
  detailData: RunData | null;
  call?: Call;
  requestedCall: string;
  pending: boolean;
  error: string;
  retrying: boolean;
  metrics: ReactNode;
  pageRange: string;
  panel: string;
  onPanel(panel: string): void;
  onSelect(id: string): void;
  onInspect(): void;
  onRetry(control: HTMLButtonElement): void;
  onFollowLatest(): void;
  onLoadMore(): void;
}

export function RunAnalysis({ data, detailData, call, requestedCall, pending, error, retrying, metrics, pageRange,
  panel, onPanel, onSelect, onInspect, onRetry, onFollowLatest, onLoadMore }: RunAnalysisProps) {
  const t = useTranslations("runAnalysis");
  const dt = useTranslations("dashboard");
  const rt = useTranslations("runVisuals");
  const id = useId();
  const details = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const responsiveFocus = useRef<HTMLElement | null>(null);
  const retryIntent = useRef<{ control: HTMLButtonElement; selection: string } | null>(null);
  const retryLock = useRef(false);
  const selection = JSON.stringify([data.project, data.run, data.selectedEpoch, requestedCall]);
  const rows = [...data.calls].reverse();
  const selectedId = requestedCall || call?.id || "";
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const position = rows.findIndex(item => item.id === selectedId);
  const older = position < 0 ? undefined : rows[position + 1];
  const newer = position < 0 ? undefined : rows[position - 1];
  const indexedCall = call ?? data.calls.find(item => item.id === requestedCall);
  const missing = !pending && !!requestedCall && !call;
  const title = indexedCall ? `${rt("panel.request")} #${String(indexedCall.index).padStart(3, "0")}` : t("selectedRequest");
  const description = (item: Call) => item.tools[0]?.intent || item.tools.map(tool => tool.name).join(" · ")
    || dt(item.status === "pending" ? "req.waiting" : "req.textReply");

  useEffect(() => {
    retryIntent.current = null;
    retryLock.current = false;
  }, [selection]);
  useEffect(() => {
    let frame = 0;
    const inNavigation = (target: Node) => list.current?.contains(target) || picker.current?.contains(target);
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !retryIntent.current?.control.contains(event.target)) retryIntent.current = null;
      if (event.type === "focusin" && event.target instanceof HTMLElement && event.target !== document.body)
        responsiveFocus.current = inNavigation(event.target) ? event.target : null;
      else if (event.type === "pointerdown" && (!(event.target instanceof Node) || !inNavigation(event.target)))
        responsiveFocus.current = null;
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const previous = responsiveFocus.current;
        if (!previous?.isConnected || previous.getClientRects().length) return;
        if (document.activeElement !== document.body && document.activeElement !== previous) return;
        const target = list.current?.contains(previous) ? picker.current?.querySelector<HTMLSelectElement>("select")
          : list.current?.querySelector<HTMLButtonElement>(`[data-request-id="${CSS.escape(currentSelection.current)}"]`)
            ?? list.current?.querySelector<HTMLButtonElement>("button");
        if (target?.getClientRects().length) target.focus();
      });
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release, true);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", release);
      document.removeEventListener("pointerdown", release, true);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if (retrying) return;
    retryLock.current = false;
    const intent = retryIntent.current;
    if (!intent || pending && !error) return;
    retryIntent.current = null;
    if (!error && !missing && intent.selection === selection && !intent.control.isConnected && document.activeElement === document.body)
      details.current?.focus({ preventScroll: true });
  }, [retrying, pending, error, missing, selection, detailData]);
  const retry = (control: HTMLButtonElement) => {
    if (retrying || retryLock.current) return;
    retryLock.current = true;
    retryIntent.current = document.activeElement === control ? { control, selection } : null;
    onRetry(control);
  };
  const retryButton = <Button type="button" variant="outline" size="sm" aria-disabled={retrying}
    className="aria-disabled:opacity-50" onClick={event => retry(event.currentTarget)}>{t(retrying ? "reading" : "retry")}</Button>;

  return <div className="run-analysis">
    <div className="run-analysis-grid">
      <section className="surface run-analysis-requests" aria-labelledby={`${id}-requests`}>
        <div className="surface-heading"><h2 id={`${id}-requests`}>{t("requests")}</h2>
          <Button type="button" variant="ghost" size="xs" onClick={onFollowLatest}>{dt("followLatest")} ↓</Button>
        </div>
        <p className="feed-notice">{pageRange}</p>
        <div ref={picker} className="run-analysis-picker">
          <label htmlFor={`${id}-request`} className="sr-only">{t("chooseRequest")}</label>
          <NativeSelect id={`${id}-request`} value={selectedId} wrapperClassName="w-full" disabled={!rows.length && !requestedCall}
            onChange={event => { if (event.target.value) onSelect(event.target.value); }}>
            {!selectedId && <NativeSelectOption value="">{t(rows.length ? "chooseRequest" : "noRequests")}</NativeSelectOption>}
            {selectedId && position < 0 && <NativeSelectOption value={selectedId}>{call ? title : t("selectedRequest")} · {t("outsidePage")}</NativeSelectOption>}
            {rows.map(item => <NativeSelectOption key={item.id} value={item.id}>
              #{String(item.index).padStart(3, "0")} · {description(item).slice(0, 100)} · {clockTime(item.at)}
            </NativeSelectOption>)}
          </NativeSelect>
          <div className="run-analysis-step-controls">
            <Button type="button" size="sm" variant="outline" aria-disabled={!older} className="aria-disabled:opacity-50"
              onClick={() => { if (older) onSelect(older.id); }}><ChevronLeft aria-hidden="true" />{t("olderRequest")}</Button>
            <Button type="button" size="sm" variant="outline" aria-disabled={!newer} className="aria-disabled:opacity-50"
              onClick={() => { if (newer) onSelect(newer.id); }}>{t("newerRequest")}<ChevronRight aria-hidden="true" /></Button>
          </div>
        </div>
        <div ref={list} className="timeline-list run-analysis-list">
          {rows.map(item => <button type="button" key={item.id} data-request-id={item.id}
            className={"request-row" + (item.id === selectedId ? " selected" : "")} aria-pressed={item.id === selectedId}
            onClick={() => onSelect(item.id)}>
            <div><b>#{String(item.index).padStart(3, "0")}</b><span className={"request-state " + item.status}>
              {item.status === "pending" ? dt("req.pending") : item.status === "error" ? dt("req.failed")
                : item.status === "aborted" ? dt("req.aborted") : seconds(item.durationMs)}
            </span></div>
            <p>{description(item)}</p>
            <small>{clockTime(item.at)}<span>{transport(item, rt)}</span></small>
            <small>{bytes(requestBytes(item))}<span>{percent(item.cacheHit)}</span></small>
          </button>)}
        </div>
        {!rows.length && <p className="run-analysis-no-requests">{data.activeCompaction ? dt("callsEmpty.compacting")
          : data.selectedEpoch ? dt("callsEmpty.noEpochCalls") : data.manifest.benchmark ? dt("callsEmpty.noBenchCalls") : dt("callsEmpty.noTakeover")}</p>}
        {data.paging.hasMore && data.paging.beforeCall !== null && <div className="run-analysis-pagination">
          <Button type="button" size="sm" variant="outline" onClick={onLoadMore}>{dt("loadMore")}</Button>
        </div>}
      </section>
      <div ref={details} className="run-analysis-detail" tabIndex={-1} aria-label={t("selectedRequest")}
        aria-busy={retrying || pending && !error} data-request-id={selectedId || undefined} data-detail-state={error ? "error" : pending ? "loading" : missing ? "missing" : "ready"}>
        {error && <Alert variant="destructive" className="run-analysis-read-error"><AlertDescription>
          <p className="font-medium">{t(detailData ? "refreshFailed" : "readFailed")}</p>
          {detailData && <p>{t("showingCached")}</p>}
          <details className="w-full text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-words">{error}</p></details>
        </AlertDescription></Alert>}
        {pending || !detailData ? <section className="surface run-analysis-placeholder">
          <h2>{title}</h2><p role="status">{t(error ? "chooseOrRetry" : "loadingRequest")}</p>
        </section> : missing ? <section className="surface run-analysis-placeholder">
          <h2>{t("requestUnavailable")}</h2><p>{t("requestUnavailableHint")}</p>
        </section> : null}
        {(error || missing) && <div className="my-3 flex flex-wrap gap-2">{retryButton}
          {missing && <Button type="button" variant="ghost" size="sm" onClick={onFollowLatest}>{dt("followLatest")} ↓</Button>}
        </div>}
        {!pending && detailData && !missing && <RequestDetails data={detailData} call={call} panel={panel} onPanel={onPanel} onSelect={onSelect} onInspect={onInspect} />}
      </div>
    </div>
    <details className="surface run-analysis-overview">
      <summary><span><BarChart3 aria-hidden="true" />{t("performanceOverview")}</span><span>{t("overviewCount").replace("{count}", String(data.paging.totalCalls))}</span></summary>
      <div className="run-analysis-overview-body"><p className="help-text">{t("overviewHint")}</p>{metrics}
        <section className="charts" aria-label={t("requestCharts")}>
          {(["latency", "cache", "body"] as const).map(type => <div className="surface chart-card" key={type}>
            <div className="surface-heading"><h2>{dt(type === "latency" ? "chart.latency" : type === "cache" ? "chart.cache" : "chart.body")}</h2>
              <span>{type === "latency" ? dt("chart.latencyHint") : type === "cache" ? "%" : dt("chart.bodyHint")}</span>
            </div><RequestChart type={type} calls={data.calls} selected={selectedId} onSelect={onSelect} />
          </div>)}
        </section>
      </div>
    </details>
  </div>;
}
