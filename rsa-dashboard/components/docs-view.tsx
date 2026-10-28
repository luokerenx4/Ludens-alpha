"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";

interface DocItem { id: string; title: string }
interface DocGroup { id: string; title: string; blurb: string; docs: DocItem[] }
interface DocDetail { id: string; title: string; group: string; html: string }

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
  const article = useRef<HTMLElement>(null);
  const groupsLoad = useJson<DocGroup[]>("/api/docs");
  const docLoad = useJson<DocDetail>(docId ? `/api/docs?doc=${encodeURIComponent(docId)}` : null);
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
      {!docId && <><div className="surface-heading"><h2>文档</h2></div>
        <div className="docs-body"><p>左侧选择一篇。教程讲怎么跑起来，介绍讲组件与契约，洞见记录当时的取舍。</p></div></>}
      {docId && docLoad.error && <div className="error-banner" role="alert">{docLoad.error}</div>}
      {docId && !doc && !docLoad.error && <div className="docs-body"><p role="status">正在读取…</p></div>}
      {doc && <><div className="surface-heading"><h2>{doc.title}</h2><span>{doc.id}</span></div>
        <div className="docs-body" dangerouslySetInnerHTML={{ __html: doc.html }} /></>}
    </article>
  </div>;
}
