"use client";

import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { readArchiveJson } from "@/lib/archive-client";
import { useLocale, useTranslations } from "@/lib/locale";
import type { ReplayDetail } from "@/lib/replay-types";
import { replayEvidenceUrl, type ReplayEvidenceSelection } from "./replay-evidence-model";

export type { ReplayEvidenceSelection } from "./replay-evidence-model";

interface EvidenceRead {
  url: string;
  detail?: ReplayDetail;
  loading: boolean;
  error: string;
}

function useEvidenceRead(url: string, onLoaded?: (detail: ReplayDetail) => void) {
  const [state, setState] = useState<EvidenceRead | null>(null);
  const [revision, setRevision] = useState(0);
  const currentUrl = useRef(url);
  const request = useRef<AbortController | null>(null);
  const loaded = useRef(onLoaded);
  currentUrl.current = url;
  loaded.current = onLoaded;
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && currentUrl.current === url;
    setState(previous => ({ url, detail: previous?.url === url ? previous.detail : undefined,
      error: previous?.url === url ? previous.error : "", loading: true }));
    void readArchiveJson<ReplayDetail>(url, controller.signal).then(detail => {
      if (!current()) return;
      setState({ url, detail, error: "", loading: false });
      loaded.current?.(detail);
    }).catch(error => {
      if (current()) setState(previous => ({ url, detail: previous?.url === url ? previous.detail : undefined,
        error: error instanceof Error ? error.message : String(error), loading: false }));
    }).finally(() => { if (request.current === controller) request.current = null; });
    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [url, revision]);
  const current = state?.url === url ? state : null;
  const loading = !current || current.loading;
  return { detail: current?.detail, error: current?.error ?? "", loading,
    retry: () => { if (!loading && !request.current) setRevision(value => value + 1); } };
}

const statuses: Record<string, string> = {
  completed: "completed", success: "completed", error: "failed", failed: "failed",
  cancelled: "cancelled", pending: "pending", running: "running",
};
const sourceKeys = ["recordId", "sequence", "eventId", "seq", "sourceId", "modelCallId", "toolCallId", "actionId", "traceId"] as const;

function RecordedInput({ observation }: { observation: NonNullable<ReplayDetail["observations"]>[number] }) {
  const t = useTranslations("replayEvidence");
  const timeline = useTranslations("timelinePlayer");
  const [failedObservation, setFailedObservation] = useState<typeof observation | null>(null);
  // A successful detail refresh may make the same recorded asset available again.
  const unavailable = !observation.url || failedObservation === observation;
  return <figure className="space-y-2 rounded-lg border bg-muted/20 p-3">
    {unavailable ? <p className="text-sm text-muted-foreground" role="status">{observation.url ? t("mediaUnavailable") : timeline("unrecordedMedia")}</p>
      : <img src={observation.url} alt={`${timeline("modelInput")} ${observation.id}`} loading="lazy"
        className="max-h-64 w-full rounded object-contain" onError={() => setFailedObservation(observation)} />}
    <figcaption className="space-y-1 text-xs text-muted-foreground">
      <p className="break-all font-mono">{observation.id}</p>
      {observation.recordId && <p className="break-all font-mono">{observation.recordId}
        {observation.sequence !== undefined && ` · #${observation.sequence}`}</p>}
      {observation.approximate && <p>{timeline("approximateNote")}</p>}
    </figcaption>
  </figure>;
}

function RawRecord({ data }: { data: unknown }) {
  const t = useTranslations("replayEvidence");
  const [open, setOpen] = useState(false);
  const text = useMemo(() => open ? JSON.stringify(data, null, 2) : "", [data, open]);
  return <details className="rounded-lg border p-3 text-xs" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t("rawRecord")}</summary>
    {open && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono leading-relaxed">{text}</pre>}
  </details>;
}

export function ReplayEvidencePanel({ scope, selection, onClose, onLoaded, focusRef }: {
  scope: string;
  selection: ReplayEvidenceSelection;
  onClose(): void;
  onLoaded?(detail: ReplayDetail): void;
  /** The parent owns opening/closing focus, including responsive Dialog behavior. */
  focusRef?: Ref<HTMLElement>;
}) {
  const t = useTranslations("replayEvidence");
  const timeline = useTranslations("timelinePlayer");
  const { locale } = useLocale();
  const headingId = useId();
  const url = replayEvidenceUrl(scope, selection);
  const { detail, error, loading, retry } = useEvidenceRead(url, onLoaded);
  const summary = detail?.summary;
  const statusKey = summary?.status && Object.hasOwn(statuses, summary.status) ? statuses[summary.status] : null;
  const source: NonNullable<ReplayDetail["summary"]>["source"] = summary?.source
    ?? (selection.kind === "frame" ? { recordId: selection.record, sequence: selection.sequence } : { eventId: selection.id });
  const time = (at: number) => new Date(at).toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", {
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  });
  return <section ref={focusRef} tabIndex={-1} aria-labelledby={headingId} aria-busy={loading}
    className="replay-evidence-panel min-w-0 rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <header className="replay-evidence-header">
      <h2 id={headingId} className="min-w-0 text-sm font-semibold">{t("panelTitle")}</h2>
      <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={timeline("closeDetails")} onClick={onClose}>
        <X aria-hidden="true" />{t("close")}
      </Button>
    </header>
    <div className="replay-evidence-body space-y-5" role="region" aria-label={t("contentLabel")} tabIndex={0}>
      <div className="min-w-0 space-y-3">
        <h3 className="break-words text-base font-semibold leading-relaxed">{detail?.title || (selection.kind === "frame" ? selection.record : selection.id) || timeline("detailsTitle")}</h3>
        {summary && <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{t(`kind.${summary.kind}`)}</Badge>
          {summary.status && <Badge variant={statusKey === "failed" ? "destructive" : "secondary"}>
            {statusKey ? timeline(`status.${statusKey}`) : summary.status}
          </Badge>}
        </div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("recordedOnly")}</p>
        <Button type="button" variant="outline" size="sm" aria-disabled={loading} className="aria-disabled:opacity-50" onClick={retry}>
          {t(loading ? "loading" : error ? "retry" : "refresh")}
        </Button>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>
        <p>{t("readFailed")}</p>
        {detail && <p>{t("showingCached")}</p>}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">{t("technicalDetails")}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{error}</pre>
        </details>
      </AlertDescription></Alert>}
      {!detail && loading && <p className="text-sm text-muted-foreground" role="status">{timeline("readingRecord")}</p>}
      {summary && Number.isFinite(summary.startAt) && <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{t("startedAt")}</dt><dd className="break-words tabular-nums"><time dateTime={new Date(summary.startAt).toISOString()}>{time(summary.startAt)}</time></dd>
        {summary.endAt !== undefined && summary.endAt !== null && Number.isFinite(summary.endAt) && <>
          <dt className="text-muted-foreground">{t("endedAt")}</dt><dd className="break-words tabular-nums"><time dateTime={new Date(summary.endAt).toISOString()}>{time(summary.endAt)}</time></dd>
        </>}
      </dl>}
      {summary?.text && <section className="space-y-2">
        <h3 className="text-sm font-medium">{t(summary.textTruncated ? "recordedTextExcerpt" : "recordedText")}</h3>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs leading-relaxed">{summary.text}</pre>
      </section>}
      {detail && (!!detail.observations?.length || summary?.kind === "model") && <section className="space-y-3" aria-label={timeline("modelObservations")}>
        <h3 className="text-sm font-medium">{timeline("modelObservations")}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("observationsHint")}</p>
        {detail.observations?.length ? detail.observations.map(observation => <RecordedInput key={`${observation.id}:${observation.url ?? ""}`} observation={observation} />)
          : <p className="text-sm text-muted-foreground">{t("noObservations")}</p>}
      </section>}
      <details className="rounded-lg border p-3 text-xs" key={`source:${url}`}>
        <summary className="cursor-pointer font-medium">{t("sourceTitle")}</summary>
        <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          {sourceKeys.map(key => source[key] !== undefined && <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(`source.${key}`)}</dt><dd className="break-all font-mono">{String(source[key])}</dd>
          </div>)}
        </dl>
      </details>
      {detail && <RawRecord key={url} data={detail.data} />}
    </div>
  </section>;
}
