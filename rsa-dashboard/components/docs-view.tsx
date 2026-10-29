"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface DocItem { id: string; title: string }
interface DocGroup { id: string; title: string; blurb: string; docs: DocItem[] }
interface DocDetail { id: string; title: string; group: string; lang: "en" | "zh"; fallback: boolean; html: string }
function useJson<T>(url: string | null): { value?: T; error?: string } {
  const t = useTranslations("docsView");
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? t("loadFailed"));
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
  const t = useTranslations("docsView");
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
    <h2>{groupsLoad.error ? t("loadFailedTitle") : t("loadingTitle")}</h2><p>{groupsLoad.error ?? t("loadingHint")}</p>
  </section>;

  return <div className="docs-layout">
    <aside className="surface docs-nav" aria-label={t("navLabel")}>
      {groups.map(group => <div key={group.id} className="docs-group">
        <div className="bench-list-heading"><span>{group.title}</span><small>{group.blurb}</small></div>
        {group.docs.map(item => <Button key={item.id} type="button" variant="ghost"
          className="mb-1 block h-auto w-full whitespace-normal border border-transparent px-3 py-3 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10"
          aria-pressed={docId === item.id}
          onClick={() => navigate({ doc: item.id, docAnchor: null })}>{item.title}</Button>)}
      </div>)}
    </aside>
    <article ref={article} className="surface docs-article" onClick={followDoc}>
      {!docId && <><div className="surface-heading"><h2>{t("overviewTitle")}</h2><span>docs/</span></div>
        <div className="docs-body">
          <p className="text-muted-foreground">{t("overviewBlurb")}</p>
          <div className="docs-overview-grid">
            {groups.map(group => <Card key={group.id} className="gap-2 p-4">
              <h3 className="m-0 text-sm">{group.title}</h3>
              <p className="mb-1 text-xs text-muted-foreground">{group.blurb}</p>
              <div className="docs-overview-links">
                {group.docs.map(item => <Button key={item.id} type="button" variant="link" size="sm" className="h-auto justify-start whitespace-normal px-0 text-left"
                  onClick={() => navigate({ doc: item.id, docAnchor: null })}>{item.title} →</Button>)}
              </div>
            </Card>)}
          </div>
        </div></>}
      {docId && docLoad.error && <Alert variant="destructive"><AlertDescription>{docLoad.error}</AlertDescription></Alert>}
      {docId && !doc && !docLoad.error && <div className="docs-body"><p role="status">{t("loadingArticle")}</p></div>}
      {doc && <><div className="surface-heading"><h2>{doc.title}</h2><span>{doc.id} · {doc.lang === "zh" ? t("chinese") : "EN"}<Button type="button" variant="link" size="xs" onClick={() => navigate({ docLang: docLang === "zh" ? "en" : "zh" })}>{docLang === "zh" ? "English" : t("chinese")}</Button></span></div>
        {doc.fallback && <Alert role="status"><AlertDescription>No English translation yet — showing the Chinese original.</AlertDescription></Alert>}
        <div className="docs-body" dangerouslySetInnerHTML={{ __html: doc.html }} /></>}
    </article>
  </div>;
}
