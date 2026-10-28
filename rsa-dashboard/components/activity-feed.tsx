"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogBlock } from "@/lib/activity";
import {
  matchesActivity,
  blockLabels,
  printable,
  type ActivityFilter,
} from "./activity-feed-model";
import type { ActivityFeedData } from "./use-activity-feed";
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
const statusNames = { running: "进行中", complete: "已完成", error: "失败" };

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
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="block-copy"
      aria-label="复制完整内容"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied("done");
        } catch {
          setCopied("error");
        }
      }}
    >
      {copied === "done" ? "已复制" : copied === "error" ? "复制失败" : "复制"}
    </button>
  );
}

function Content({ text, code = false }: { text: string; code?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 8;
  const preview = long
    ? text.slice(0, 420).split("\n").slice(0, 8).join("\n")
    : text;
  return (
    <div className={`block-content${code ? " block-code" : ""}`}>
      {long ? (
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            {expanded ? "收起完整内容" : "展开完整内容"}
            <span>{text.length.toLocaleString()} 字符</span>
          </summary>
          {expanded && <pre className="block-body block-full">{text}</pre>}
        </details>
      ) : null}
      {!expanded && (
        <pre className="block-body">
          {preview}
          {long ? "…" : ""}
        </pre>
      )}
    </div>
  );
}

function ActivityBlock({
  block,
  selected,
  onSelect,
}: {
  block: LogBlock;
  selected: boolean;
  onSelect?: (block: LogBlock) => void;
}) {
  const source = block.source?.component;
  const sourceName = source ? (sourceNames[source] ?? source) : "来源未标注";
  const time = new Date(block.at);
  const at = Number.isNaN(time.getTime())
    ? block.at
    : time.toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <article
      className={`block-item block-${block.kind}${selected ? " block-selected" : ""}${block.status === "error" ? " block-error" : ""}`}
      aria-label={`${blockLabels[block.kind]}：${block.title}`}
    >
      <div className="block-icon">
        <BlockIcon kind={block.kind} />
      </div>
      <div className="block-main">
        <div className="block-heading">
          <span className="block-source" title={block.source?.implementation}>
            {sourceName}
          </span>
          <span className="block-kind">{blockLabels[block.kind]}</span>
          <time dateTime={block.at} title={block.at}>
            {at}
          </time>
          <span className={`block-status block-status-${block.status}`}>
            {block.outcome === "raised" ? "函数抛异常" : block.outcome === "unmet" ? "目标未达成" : statusNames[block.status]}
          </span>
        </div>
        <div className="block-title-row">
          {onSelect ? (
            <button
              type="button"
              className="block-title"
              onClick={() => onSelect(block)}
              title="定位此日志与关联请求"
            >
              {block.title}
            </button>
          ) : (
            <span className="block-title">{block.title}</span>
          )}
          <CopyButton text={block.text} />
        </div>
        {block.kind === "tool" && block.tool ? (
          <div className="block-tool-fields">
            {block.tool.intent && (
              <section className="block-field">
                <h4>意图</h4>
                <Content text={block.tool.intent} />
              </section>
            )}
            {block.tool.args !== undefined && (
              <section className="block-field">
                <h4>参数</h4>
                <Content text={printable(block.tool.args)} code />
              </section>
            )}
            {block.tool.result !== undefined ? (
              <section className="block-field">
                <h4>结果</h4>
                <Content text={printable(block.tool.result)} code />
              </section>
            ) : block.status === "running" ? (
              <p className="block-pending">等待工具结果…</p>
            ) : null}
          </div>
        ) : (
          <Content text={block.text} code={block.kind === "diagnostic"} />
        )}
        {(block.trace?.modelCallId || block.trace?.spanId || block.eventId) && (
          <details className="block-provenance">
            <summary>来源与关联</summary>
            <dl>
              {block.source?.implementation && (
                <>
                  <dt>实现</dt>
                  <dd>
                    {block.source.implementation}
                    {block.source.implementationVersion &&
                      ` · ${block.source.implementationVersion}`}
                  </dd>
                </>
              )}
              {block.trace?.modelCallId && (
                <>
                  <dt>请求</dt>
                  <dd>{block.trace.modelCallId}</dd>
                </>
              )}
              {block.trace?.traceId && (
                <>
                  <dt>Trace</dt>
                  <dd>{block.trace.traceId}</dd>
                </>
              )}
              {block.trace?.spanId && (
                <>
                  <dt>Span</dt>
                  <dd>{block.trace.spanId}</dd>
                </>
              )}
              {block.eventId && (
                <>
                  <dt>事件</dt>
                  <dd>{block.eventId}</dd>
                </>
              )}
            </dl>
          </details>
        )}
      </div>
    </article>
  );
}

export function ActivityFeed({ feed, expectedEpoch, selectedBlock, onSelect }: ActivityFeedProps) {
  const { filter, query, setFilter, setQuery } = feed;
  const consistent = expectedEpoch === undefined || feed.scope?.epoch === expectedEpoch;
  const page = consistent ? feed.blocks.filter(block => matchesActivity(block, filter, query)) : [];
  const selected = consistent ? page.find(block => block.id === selectedBlock) ?? feed.selected : undefined;
  const pinned = selected && !page.some(block => block.id === selected.id) ? selected : undefined;
  const loading = feed.loading || !consistent;
  const missingSelection = Boolean(selectedBlock && feed.selectionReady && !selected && consistent);
  const list = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const initiallyPositioned = useRef(false);
  const positionLatest = useRef(false);
  const previousAnchor = useRef<{ id: string; top: number } | null>(null);
  const selectionPresent = Boolean(selected);
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
    <section className="feed-panel" aria-label="活动日志">
      <header className="feed-heading">
        <h2>活动日志</h2>
        <span title="当前筛选最近一次历史查询的总数">
          {loading ? "读取中…" : `${feed.total.toLocaleString()} 条`}
        </span>
      </header>
      <div className="feed-filters" role="group" aria-label="日志类型">
        {filters.map((kind) => (
          <button type="button" key={kind}
            className={`feed-filter${filter === kind ? " feed-filter-active" : ""}${kind === "diagnostic" ? " feed-filter-diagnostic" : ""}`}
            aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
            {kind === "all" ? "全部" : blockLabels[kind]}
          </button>
        ))}
      </div>
      <div className="feed-search-row">
        <label className="feed-search">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" />
          </svg>
          <input aria-label="搜索活动日志" type="search" placeholder="搜索内容、工具或来源"
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="feed-latest" title="返回当前筛选下最新的 100 条"
          onClick={() => { positionLatest.current = true; feed.latest(); }}>
          最新 <span aria-hidden="true">↓</span>
        </button>
      </div>
      {feed.error && <p className="feed-error" role="alert">日志读取失败：{feed.error}
        {page.length > 0 ? "；以下为上次读取内容。" : ""}</p>}
      {missingSelection && !loading && <p className="feed-notice">这条日志不在当前运行中，请检查运行与轮次选择。</p>}
      <div ref={list} className="feed-list" aria-busy={loading || feed.loadingOlder}>
        {pinned && <div className="feed-pinned">
          <p className="feed-notice">正在定位的日志 · 位于当前筛选或分页之外</p>{renderBlock(pinned)}
        </div>}
        {feed.hasMore && consistent && <button type="button" className="feed-earlier"
          disabled={loading || feed.loadingOlder} onClick={() => {
            const first = page[0];
            const node = first && nodes.current.get(first.id);
            if (node) previousAnchor.current = { id: first.id, top: node.getBoundingClientRect().top };
            void feed.earlier();
          }}>
          {feed.loadingOlder ? "读取更早记录…" : "加载更早的 100 条"}
          <span>历史记录按页读取</span>
        </button>}
        {page.map(renderBlock)}
        {page.length === 0 && !pinned && <div className="feed-empty">
          <BlockIcon kind={filter === "all" ? "text" : filter} />
          <p>{loading ? "正在读取活动日志…" : feed.total === 0 && filter === "all" && !query
            ? "这个运行还没有活动日志" : "没有符合筛选条件的日志"}</p>
          <span>{!loading && !query ? "模型输出和工具调用会在这里显示。" : query ? "换个关键词，或选择其他日志类型。" : ""}</span>
        </div>}
      </div>
      <footer className="feed-footer">
        <span>窗口内 {page.length.toLocaleString()} 条 · 历史查询共 {feed.total.toLocaleString()} 条
          {pinned ? " · 已保留定位日志" : ""}</span>
        <span>{feed.historical ? "较早记录 · 点最新返回" : filter === "all" ? "诊断按需查看" : blockLabels[filter]}</span>
      </footer>
    </section>
  );
}
