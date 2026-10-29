"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogBlock } from "@/lib/activity";
import {
  activityContentView,
  activityProvenance,
  matchesActivity,
  printable,
  type ActivityFilter,
} from "./activity-feed-model";
import type { ActivityFeedData } from "./use-activity-feed";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./activity-feed.css";

interface ActivityFeedProps {
  feed: ActivityFeedData;
  expectedEpoch?: string | null;
  selectedBlock?: string;
  onSelect?: (block: LogBlock) => void;
}

const filters: ActivityFilter[] = [
  "all",
  "thinking",
  "text",
  "tool",
  "system",
  "diagnostic",
];
const sourceNames: Record<string, string> = {
  shiori: "Shiori",
  rsa: "RSA",
  baseware: "Baseware",
  pet: "Ludens Pet",
  dashboard: "Dashboard",
};

function BlockIcon({ kind }: { kind: LogBlock["kind"] }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "thinking" ? (
        <>
          <path d="M9 18H7a4 4 0 0 1-1-7.9A5 5 0 0 1 15 6a4 4 0 0 1 3.9 6A3.5 3.5 0 0 1 18 19h-3" />
          <path d="M10 9c-2 0-2 4 0 4v7m4-12c2 0 2 5 0 5v7m-5-5h6" />
        </>
      ) : kind === "tool" ? (
        <path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z" />
      ) : kind === "system" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 3 3 5-6" />
        </>
      ) : kind === "diagnostic" ? (
        <>
          <path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-15-2 16" />
        </>
      ) : (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6m-6 4h6m-6 4h4" />
        </>
      )}
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useTranslations("activityFeed");
  const [feedback, setFeedback] = useState<{ text: string; status: "pending" | "done" | "error" } | null>(null);
  const attempt = useRef(0);
  const pending = useRef(false);
  const status = feedback?.text === text ? feedback.status : "idle";
  useLayoutEffect(() => {
    // A new streamed value owns its own feedback; old clipboard promises may still settle.
    pending.current = false;
    attempt.current += 1;
    setFeedback(null);
    return () => { attempt.current += 1; };
  }, [text]);
  useEffect(() => {
    if (status !== "done" && status !== "error") return;
    const timer = window.setTimeout(() => setFeedback(null), 1800);
    return () => window.clearTimeout(timer);
  }, [status, text]);
  return (
    <div className="block-copy-action">
      <Button type="button" variant="ghost" size="xs" className="block-copy-button"
        data-activity-copy aria-label={t("copyAria")} aria-disabled={status === "pending"}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          const current = ++attempt.current;
          setFeedback({ text, status: "pending" });
          try {
            await navigator.clipboard.writeText(text);
            if (attempt.current === current) setFeedback({ text, status: "done" });
          } catch {
            if (attempt.current === current) setFeedback({ text, status: "error" });
          } finally {
            if (attempt.current === current) pending.current = false;
          }
        }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" />
        </svg>
        {t("copyLabel")}
      </Button>
      <span className={`block-copy-feedback${status === "error" ? " block-copy-error" : ""}`}
        role="status" aria-atomic="true" data-activity-copy-status={status}>
        {status === "pending" ? t("copyPending") : status === "done" ? t("copyDone") : status === "error" ? t("copyFailed") : ""}
      </span>
    </div>
  );
}

function Content({ text, code = false }: { text: string; code?: boolean }) {
  const t = useTranslations("activityFeed");
  const [requestedExpanded, setExpanded] = useState(false);
  const { canExpand, expanded, text: visibleText, characters } = activityContentView(text, requestedExpanded);
  return (
    <div className={`block-content${code ? " block-code" : ""}`} data-activity-content>
      {canExpand ? (
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary data-activity-expand>
            {expanded ? t("collapseLabel") : t("expandLabel")}
            <span>{characters.toLocaleString()}{t("charsUnit")}</span>
          </summary>
          {expanded && <pre className="block-body block-full" tabIndex={0} role="region" aria-label={t("fullContentLabel")}>{visibleText}</pre>}
        </details>
      ) : null}
      {!expanded && <pre className="block-body">{visibleText}{canExpand ? "…" : ""}</pre>}
    </div>
  );
}

const provenanceLabels: Record<string, string> = {
  id: "id", at: "at", updatedAt: "updatedAt", eventId: "eventId", seq: "seq",
  "source.component": "sourceComponent", "source.implementation": "sourceImplementation",
  "source.implementationVersion": "sourceVersion", "trace.modelCallId": "modelCallId",
  "trace.toolCallId": "toolCallId", "trace.actionId": "actionId", "trace.traceId": "traceId",
  "trace.spanId": "spanId", "trace.parentSpanId": "parentSpanId", "trace.epoch": "epoch",
};

function ActivityBlock({
  block,
  selected,
  onSelect,
}: {
  block: LogBlock;
  selected: boolean;
  onSelect?: (block: LogBlock) => void;
}) {
  const t = useTranslations("activityFeed");
  const source = block.source?.component;
  const sourceName = source ? (sourceNames[source] ?? source) : t("sourceUnknown");
  const provenance = activityProvenance(block);
  const time = new Date(block.at);
  const at = Number.isNaN(time.getTime())
    ? block.at
    : time.toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <article
      className={`block-item block-${block.kind}${selected ? " block-selected" : ""}${block.status === "error" ? " block-error" : ""}`}
      aria-label={`${t(`kind.${block.kind}`)}: ${block.title}`}
      data-activity-block={block.id}
    >
      <div className="block-main">
        <div className="block-heading">
          <div className="block-icon"><BlockIcon kind={block.kind} /></div>
          <span className="block-source" title={source}>
            {sourceName}
          </span>
          <Badge variant="secondary" className="rounded px-1.5 py-0 text-[11px]">{t(`kind.${block.kind}`)}</Badge>
          <time dateTime={block.at} title={block.at}>
            {at}
          </time>
          <Badge variant={block.status === "error" ? "destructive" : "outline"}
            className={`ml-auto px-1.5 py-0 text-[10px]${block.status === "running" ? " border-primary/40 text-primary" : ""}`}>
            {block.outcome === "raised" ? t("outcomeRaised") : block.outcome === "unmet" ? t("outcomeUnmet") : t(`status.${block.status}`)}
          </Badge>
        </div>
        <div className="block-title-row">
          {onSelect ? (
            <button
              type="button"
              className="block-title rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(block)}
              title={t("locateTitle")}
            >
              {block.title}
            </button>
          ) : (
            <span className="block-title">{block.title}</span>
          )}
        </div>
        {block.kind === "tool" && block.tool ? (
          <div className="block-tool-fields">
            {block.tool.intent && (
              <section className="block-field">
                <h4>{t("intentHeading")}</h4>
                <Content text={block.tool.intent} />
              </section>
            )}
            {block.tool.args !== undefined && (
              <section className="block-field">
                <h4>{t("argsHeading")}</h4>
                <Content text={printable(block.tool.args)} code />
              </section>
            )}
            {block.tool.result !== undefined ? (
              <section className="block-field">
                <h4>{t("resultHeading")}</h4>
                <Content text={printable(block.tool.result)} code />
              </section>
            ) : block.status === "running" ? (
              <p className="block-pending">{t("pendingResult")}</p>
            ) : null}
          </div>
        ) : (
          <Content text={block.text} code={block.kind === "diagnostic"} />
        )}
        <div className="block-actions"><CopyButton text={block.text} /></div>
        <details className="block-provenance" data-activity-provenance>
          <summary>{t("provenanceTitle")}</summary>
          <dl>
            {provenance.map(({ field, value }) => (
              <div className="block-provenance-row" key={field} data-activity-source={field}>
                <dt title={field}>{provenanceLabels[field] ? t(`provenance.${provenanceLabels[field]}`) : field}</dt>
                <dd>{value === "" ? '\"\"' : value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </article>
  );
}

export function ActivityFeed({ feed, expectedEpoch, selectedBlock, onSelect }: ActivityFeedProps) {
  const { filter, query, setFilter, setQuery } = feed;
  const t = useTranslations("activityFeed");
  const consistent = expectedEpoch === undefined || feed.scope?.epoch === expectedEpoch;
  const page = consistent ? feed.blocks.filter(block => matchesActivity(block, filter, query)) : [];
  const selected = consistent ? page.find(block => block.id === selectedBlock) ?? feed.selected : undefined;
  const pinned = selected && !page.some(block => block.id === selected.id) ? selected : undefined;
  const loading = feed.loading;
  const missingSelection = Boolean(selectedBlock && feed.selectionReady && !selected && consistent && !feed.error);
  const list = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const initiallyPositioned = useRef(false);
  const positionLatest = useRef(false);
  const previousAnchor = useRef<{ id: string; top: number } | null>(null);
  const selectionPresent = Boolean(selected);
  const positionedRevision = useRef(feed.resetRevision);
  useLayoutEffect(() => {
    if (positionedRevision.current === feed.resetRevision) return;
    positionedRevision.current = feed.resetRevision;
    initiallyPositioned.current = false;
    previousAnchor.current = null;
    positionLatest.current = true;
  }, [feed.resetRevision]);
  useEffect(() => {
    if (selectedBlock && selectionPresent)
      nodes.current.get(selectedBlock)?.scrollIntoView({ block: "nearest" });
  }, [selectedBlock, selectionPresent]);
  useLayoutEffect(() => {
    if (loading || feed.loadingOlder) return;
    const anchor = previousAnchor.current;
    if (anchor && list.current) {
      const node = nodes.current.get(anchor.id);
      if (node) list.current.scrollTop += node.getBoundingClientRect().top - anchor.top;
      previousAnchor.current = null;
    }
    if (positionLatest.current || (!initiallyPositioned.current && page.length > 0 && !selectedBlock)) {
      list.current?.scrollTo({ top: list.current.scrollHeight });
      initiallyPositioned.current = true;
      positionLatest.current = false;
    }
  }, [feed.blocks, feed.loadingOlder, loading, page.length, selectedBlock]);
  const renderBlock = (block: LogBlock) => (
    <div key={block.id} ref={(node) => {
      if (node) nodes.current.set(block.id, node);
      else nodes.current.delete(block.id);
    }}>
      <ActivityBlock block={block} selected={block.id === selectedBlock} onSelect={onSelect} />
    </div>
  );
  return (
    <section className="feed-panel" aria-label={t("panelLabel")}>
      <header className="feed-heading">
        <h2>{t("feedTitle")}</h2>
        <span title={t("totalTitle")}>
          {loading ? t("loadingLabel") : `${feed.total.toLocaleString()}${t("itemsUnit")}`}
        </span>
      </header>
      <div className="feed-filters" role="group" aria-label={t("filtersLabel")}>
        {filters.map((kind) => (
          <Button type="button" key={kind} size="xs" variant={filter === kind ? "default" : "outline"}
            className={kind === "diagnostic" && filter !== kind ? "border-dashed text-muted-foreground" : undefined}
            aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
            {kind === "all" ? t("filterAll") : t(`kind.${kind}`)}
          </Button>
        ))}
      </div>
      <div className="feed-search-row">
        <label className="relative min-w-0 flex-1">
          <svg className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" />
          </svg>
          <Input className="h-8 pl-8 text-xs" aria-label={t("searchAria")} type="search" placeholder={t("searchPlaceholder")}
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Button type="button" variant="outline" size="sm" className="shrink-0" title={t("latestTitle")} disabled={!feed.scope}
          onClick={() => { positionLatest.current = true; feed.latest(); }}>
          {t("latestLabel")} <span aria-hidden="true">↓</span>
        </Button>
      </div>
      {feed.error && <Alert variant="destructive" className="mx-4 mb-3 w-auto px-3 py-2">
        <AlertDescription className="text-xs">{t("loadErrorPrefix")}{feed.error}{page.length > 0 ? t("loadErrorCachedSuffix") : ""}</AlertDescription>
      </Alert>}
      {missingSelection && !loading && <Alert role="status" className="mx-4 mb-3 w-auto px-3 py-2">
        <AlertDescription className="text-xs">{t("missingSelectionNotice")}</AlertDescription>
      </Alert>}
      <div ref={list} className="feed-list" aria-busy={loading || feed.loadingOlder}>
        {pinned && <div className="feed-pinned">
          <p className="feed-notice">{t("pinnedNotice")}</p>{renderBlock(pinned)}
        </div>}
        {feed.hasMore && consistent && <Button type="button" variant="outline" size="sm"
          className="mx-[18px] mt-3 h-auto w-[calc(100%-36px)] flex-wrap gap-x-2 whitespace-normal px-3 py-2 text-xs"
          disabled={loading || feed.loadingOlder} onClick={() => {
            const first = page[0];
            const node = first && nodes.current.get(first.id);
            if (node) previousAnchor.current = { id: first.id, top: node.getBoundingClientRect().top };
            void feed.earlier();
          }}>
          {feed.loadingOlder ? t("loadingEarlier") : t("loadEarlier")}
          <span className="text-muted-foreground">{t("earlierHint")}</span>
        </Button>}
        {page.map(renderBlock)}
        {page.length === 0 && !pinned && <div className="feed-empty">
          <BlockIcon kind={filter === "all" ? "text" : filter} />
          <p>{loading ? t("emptyLoading") : feed.error ? t("emptyReadFailed") : !consistent ? t("scopeMismatch") : feed.total === 0 && filter === "all" && !query
            ? t("emptyNone") : t("emptyFiltered")}</p>
          <span>{!loading && (feed.error || !consistent) ? t("retryLatestHint") : !loading && !query ? t("emptyHintDefault") : query ? t("emptyHintQuery") : ""}</span>
        </div>}
      </div>
      <footer className="feed-footer">
        <span>{t("footerInWindow")} {page.length.toLocaleString()}{t("itemsUnit")} {t("footerHistoryTotal")} {feed.total.toLocaleString()}{t("itemsUnit")}
          {pinned ? t("pinnedKept") : ""}</span>
        <span>{feed.historical ? t("footerHistorical") : filter === "all" ? t("footerDiagnostic") : t(`kind.${filter}`)}</span>
      </footer>
    </section>
  );
}
