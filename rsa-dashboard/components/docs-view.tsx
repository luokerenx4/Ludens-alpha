"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";

interface DocItem { id: string; title: string }
interface DocGroup { id: string; title: string; blurb: string; docs: DocItem[] }
interface DocDetail { id: string; title: string; group: string; lang: "en" | "zh"; fallback: boolean; html: string }
function useJson<T>(url: string | null): { value?: T; error?: string } {
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "读取失败");
        if (!controller.signal.aborted) setLoaded({ url, value });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined, error: String(error) }));
      }
    };
    void load();
    return () => controller.abort();
  }, [url]);
  return loaded?.url === url ? loaded : {};
}

export function DocsView({ search, navigate }: {
  search: string; navigate: (patch: Record<string, string | null>) => void;
}) {
  const query = new URLSearchParams(search);
  const docId = query.get("doc");
  const docAnchor = query.get("docAnchor");
  const docLang = query.get("docLang") === "zh" ? "zh" : "en";
  const article = useRef<HTMLElement>(null);
  const groupsLoad = useJson<DocGroup[]>("/api/docs");
  const docLoad = useJson<DocDetail>(docId ? `/api/docs?lang=${docLang}&doc=${encodeURIComponent(docId)}` : null);
  const groups = groupsLoad.value;
  const doc = docLoad.value;
  const displayedDocId = groups && doc ? doc.id : undefined;

  useEffect(() => {
    if (!displayedDocId || displayedDocId !== docId) return;
    const target = docAnchor ? article.current?.querySelector<HTMLElement>(`#${CSS.escape(docAnchor)}`) : article.current;
    target?.scrollIntoView({ block: "start" });
  }, [displayedDocId, docId, docAnchor]);

  const followDoc = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLAnchorElement>("a[data-doc]");
    if (!target || !event.currentTarget.contains(target)) return;
    event.preventDefault();
    const anchor = target.dataset.docAnchor || null;
    navigate({ doc: target.dataset.doc ?? null, docAnchor: anchor });
    // Re-clicking the current anchor does not change URL state.
    if (target.dataset.doc === doc?.id && anchor) article.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: "start" });
  };

  if (!groups) return <section className="surface empty-state main-empty" aria-live="polite">
    <h2>{groupsLoad.error ? "暂时无法读取文档" : "正在读取文档"}</h2><p>{groupsLoad.error ?? "从仓库 docs/ 实时读取。"}</p>
  </section>;

  return <div className="docs-layout">
    <aside className="surface docs-nav" aria-label="文档目录">
      {groups.map(group => <div key={group.id} className="docs-group">
        <div className="bench-list-heading"><span>{group.title}</span><small>{group.blurb}</small></div>
        {group.docs.map(item => <button key={item.id}
          className={`bench-case-item${docId === item.id ? " selected" : ""}`}
          aria-pressed={docId === item.id}
          onClick={() => navigate({ doc: item.id, docAnchor: null })}>{item.title}</button>)}
      </div>)}
    </aside>
    <article ref={article} className="surface docs-article" onClick={followDoc}>
      {!docId && <><div className="surface-heading"><h2>文档导览</h2><span>docs/</span></div>
        <div className="docs-body">
          <p className="muted">选择左侧条目或下方卡片直接阅读。教程聚焦上手与工作区编程，契约定义组件与协议边界，洞见记录长跑实测背后的设计取舍。</p>
          <div className="docs-overview-grid">
            {groups.map(group => <section key={group.id} className="docs-overview-card">
              <h3>{group.title}</h3>
              <p>{group.blurb}</p>
              <div className="docs-overview-links">
                {group.docs.map(item => <button key={item.id} type="button" className="text-button"
                  onClick={() => navigate({ doc: item.id, docAnchor: null })}>{item.title} →</button>)}
              </div>
            </section>)}
          </div>
        </div></>}
      {docId && docLoad.error && <div className="error-banner" role="alert">{docLoad.error}</div>}
      {docId && !doc && !docLoad.error && <div className="docs-body"><p role="status">正在读取…</p></div>}
      {doc && <><div className="surface-heading"><h2>{doc.title}</h2><span>{doc.id} · {doc.lang === "zh" ? "中文" : "EN"}<button type="button" className="text-button" onClick={() => navigate({ docLang: docLang === "zh" ? "en" : "zh" })}>{docLang === "zh" ? "English" : "中文"}</button></span></div>
        {doc.fallback && <div className="error-banner" role="status">No English translation yet — showing the Chinese original.</div>}
        <div className="docs-body" dangerouslySetInnerHTML={{ __html: doc.html }} /></>}
    </article>
  </div>;
}
