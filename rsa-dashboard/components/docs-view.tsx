"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, Copy, List, RefreshCw, Search, X } from "lucide-react";
import type { DocCodeBlock, DocDetail, DocGroupInfo } from "@/lib/docs";
import { useLocale, useTranslations } from "@/lib/locale";
import { useReadResource } from "./use-read-resource";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

function documentUrl(search: string, id: string | null, anchor: string | null = null) {
  const params = new URLSearchParams(search);
  params.set("view", "docs");
  if (id) params.set("doc", id); else params.delete("doc");
  if (anchor) params.set("docAnchor", anchor); else params.delete("docAnchor");
  return "/?" + params.toString();
}

function CopyCode({ block }: { block: DocCodeBlock }) {
  const t = useTranslations("docsView");
  const [result, setResult] = useState<"" | "copied" | "failed">("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      if (mounted.current) setResult("copied");
    } catch { if (mounted.current) setResult("failed"); }
  };
  return <>
    <span className="text-xs text-muted-foreground">{block.language || t("code")}</span>
    <Button type="button" variant="ghost" size="xs" onClick={() => void copy()} aria-label={t(result === "copied" ? "copied" : "copyCode")}>
      {result === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{t(result === "copied" ? "copied" : "copy")}
    </Button>
    <span role="status" className={result === "failed" ? "basis-full text-xs text-destructive" : "sr-only"}>
      {result === "failed" ? t("copyFailed") : result === "copied" ? t("copied") : ""}
    </span>
  </>;
}

/** The renderer owns escaped Markdown; React owns the interactive code toolbars. */
function DocBody({ doc, search }: { doc: DocDetail; search: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [toolbars, setToolbars] = useState<{ block: DocCodeBlock; node: Element }[]>([]);
  useLayoutEffect(() => {
    setToolbars(doc.codeBlocks.flatMap(block => {
      const node = root.current?.querySelector(`[data-doc-code-toolbar="${CSS.escape(block.id)}"]`);
      return node ? [{ block, node }] : [];
    }));
  }, [doc]);
  useLayoutEffect(() => {
    for (const link of root.current?.querySelectorAll<HTMLAnchorElement>("a[data-doc]") ?? []) {
      link.href = documentUrl(search, link.dataset.doc ?? null, link.dataset.docAnchor || null);
    }
  }, [doc.html, search]);
  return <>
    <div ref={root} className="docs-body" dangerouslySetInnerHTML={{ __html: doc.html }} />
    {toolbars.map(({ block, node }) => createPortal(<CopyCode key={block.code} block={block} />, node, block.id))}
  </>;
}

function ReadNotice({ title, error, cached, loading, retry }: {
  title: string; error: string; cached: boolean; loading: boolean; retry(control: HTMLButtonElement): void;
}) {
  const t = useTranslations("docsView");
  return <Alert variant="destructive" className="docs-read-notice">
    <AlertDescription>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">{title}</p>{cached && <p>{t("showingCached")}</p>}</div>
        <Button type="button" variant="outline" size="sm" aria-disabled={loading} onClick={event => { if (!loading) retry(event.currentTarget); }}>
          {t(loading ? "retrying" : "retry")}
        </Button>
      </div>
      <details className="mt-2 text-xs"><summary className="cursor-pointer">{t("errorDetails")}</summary><p className="mt-2 break-words">{error}</p></details>
    </AlertDescription>
  </Alert>;
}

export function DocsView({ search, navigate }: {
  search: string; navigate: (patch: Record<string, string | null>) => void;
}) {
  const t = useTranslations("docsView");
  const { locale } = useLocale();
  const query = new URLSearchParams(search);
  const docId = query.get("doc");
  const docAnchor = query.get("docAnchor");
  const languageChoice = query.get("docLang") === "zh" ? "zh" : query.get("docLang") === "en" ? "en" : "auto";
  const docLang = languageChoice === "auto" ? locale : languageChoice;
  const article = useRef<HTMLElement>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  const initialDocument = useRef(docId);
  const previousPosition = useRef("");
  const navigatedFromDialog = useRef(false);
  const retryFocus = useRef<{ resource: "index" | "article"; control: HTMLElement; target: HTMLElement | null } | null>(null);
  const [menu, setMenu] = useState<"docs" | "headings" | null>(null);
  const [filter, setFilter] = useState("");
  const groupsLoad = useReadResource<DocGroupInfo[]>(`/api/docs?lang=${docLang}`, t("loadFailed"));
  const docLoad = useReadResource<DocDetail>(docId ? `/api/docs?lang=${docLang}&doc=${encodeURIComponent(docId)}` : null, t("loadFailed"));
  const groups = groupsLoad.value;
  const doc = docLoad.value;
  const headings = doc?.headings.filter(heading => heading.level > 1 && heading.level < 4) ?? [];
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredGroups = groups?.map(group => ({ ...group, docs: group.docs.filter(item =>
    `${item.title} ${item.id}`.toLocaleLowerCase().includes(normalizedFilter)) })).filter(group => group.docs.length);
  const resultCount = filteredGroups?.reduce((count, group) => count + group.docs.length, 0) ?? 0;
  const currentGroup = groups?.find(group => group.id === doc?.group);
  const missingAnchor = !!docAnchor && !!doc && !doc.headings.some(heading => heading.id === docAnchor);

  const retryRead = (resource: "index" | "article", control: HTMLButtonElement) => {
    if (document.activeElement === control) retryFocus.current = {
      resource, control,
      target: resource === "index" ? control.closest(".docs-menu-content")?.querySelector<HTMLInputElement>("input") ?? article.current : article.current,
    };
    (resource === "index" ? groupsLoad : docLoad).retry();
  };
  useEffect(() => {
    const release = (event: Event) => {
      if (event.target !== retryFocus.current?.control) retryFocus.current = null;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release);
    return () => { document.removeEventListener("focusin", release); document.removeEventListener("pointerdown", release); };
  }, []);
  useEffect(() => { retryFocus.current = null; }, [docId, docLang]);
  useEffect(() => {
    const intent = retryFocus.current;
    if (!intent) return;
    const load = intent.resource === "index" ? groupsLoad : docLoad;
    if (load.loading) return;
    retryFocus.current = null;
    // Only restore a disappearing Retry button's focus; never pull it back from another control.
    if (!load.error && !intent.control.isConnected && document.activeElement === document.body && intent.target?.isConnected) {
      intent.target.focus({ preventScroll: true });
    }
  }, [groupsLoad.loading, groupsLoad.error, docLoad.loading, docLoad.error]);

  const focusArticle = (anchor: string | null) => {
    const section = anchor ? article.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`) : null;
    const target = section?.getClientRects().length ? section : article.current;
    if (!target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    if (!doc || doc.id !== docId) return;
    const position = `${doc.id}:${doc.lang}:${docAnchor ?? ""}`;
    if (position === previousPosition.current) return;
    const first = !previousPosition.current;
    previousPosition.current = position;
    // Initial reading starts at the page top, with workspace and document controls visible.
    if (!first || docAnchor || initialDocument.current !== docId) focusArticle(docAnchor);
  }, [doc, docId, docAnchor]);

  const followDoc = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLAnchorElement>("a[data-doc]");
    if (!target || !event.currentTarget.contains(target) || target.target === "_blank" || target.hasAttribute("download")) return;
    event.preventDefault();
    const nextDoc = target.dataset.doc || null;
    const anchor = target.dataset.docAnchor || null;
    navigatedFromDialog.current = menu !== null;
    setMenu(null);
    navigate({ doc: nextDoc, docAnchor: anchor });
    requestAnimationFrame(() => focusArticle(nextDoc === doc?.id ? anchor : null));
  };

  const documentMenu = <div className="docs-menu-content">
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input type="search" className="pl-9" aria-label={t("searchLabel")} placeholder={t("searchPlaceholder")} value={filter} onChange={event => setFilter(event.target.value)} />
    </div>
    <p className="text-xs text-muted-foreground">{t("searchHint")}</p>
    {groupsLoad.error && <ReadNotice title={t("indexFailed")} error={groupsLoad.error} cached={!!groups} loading={groupsLoad.loading} retry={control => retryRead("index", control)} />}
    {!groups && !groupsLoad.error && <p role="status" className="text-sm text-muted-foreground">{t("loadingTitle")}</p>}
    {groups && <>
      {normalizedFilter && <p role="status" className="text-xs text-muted-foreground">{t("matches").replace("{count}", String(resultCount))}</p>}
      {resultCount === 0 && <div className="space-y-2 text-sm text-muted-foreground"><p>{t(normalizedFilter ? "noMatches" : "noDocuments")}</p>
        {normalizedFilter && <Button type="button" size="sm" variant="outline" onClick={() => setFilter("")}>{t("clearSearch")}</Button>}
      </div>}
      <nav aria-label={t("navLabel")} onClick={followDoc}>
        {!normalizedFilter && <Button asChild variant="ghost" className="docs-nav-link mb-4 h-auto justify-start whitespace-normal text-left">
          <a href={documentUrl(search, null)} data-doc="" aria-current={!docId ? "page" : undefined}>{t("overviewLink")}</a>
        </Button>}
        {filteredGroups?.map(group => <div key={group.id} className="docs-group">
          <h3>{group.title}</h3>
          {group.docs.map(item => <Button key={item.id} asChild variant="ghost" className="docs-nav-link h-auto justify-start whitespace-normal text-left">
            <a href={documentUrl(search, item.id)} data-doc={item.id} aria-current={docId === item.id ? "page" : undefined}>
              <span>{item.title}</span>{item.fallback && <small lang={item.lang}>{item.lang === "zh" ? "中文" : "EN"}</small>}
            </a>
          </Button>)}
        </div>)}
      </nav>
    </>}
    <Button type="button" variant="ghost" size="sm" className="justify-start text-muted-foreground" aria-disabled={groupsLoad.loading}
      onClick={() => { if (!groupsLoad.loading) groupsLoad.retry(); }}><RefreshCw aria-hidden="true" />{t("refreshIndex")}</Button>
  </div>;
  const headingMenu = <nav aria-label={t("onThisPage")} className="docs-heading-links" onClick={followDoc}>
    {headings.map(heading => <a key={heading.id} href={documentUrl(search, docId, heading.id)} data-doc={docId} data-doc-anchor={heading.id}
      data-level={heading.level} aria-current={docAnchor === heading.id ? "location" : undefined}>{heading.text}</a>)}
  </nav>;
  const dialogMenu = (kind: "docs" | "headings") => <Dialog open={menu === kind} onOpenChange={open => { navigatedFromDialog.current = false; setMenu(open ? kind : null); }}>
    <DialogTrigger asChild><Button type="button" variant="outline" size="sm" className={kind === "docs" ? "hidden max-[900px]:inline-flex" : "hidden max-[1300px]:inline-flex"}>
      {kind === "docs" ? <BookOpen aria-hidden="true" /> : <List aria-hidden="true" />}{t(kind === "docs" ? "docsMenu" : "onThisPage")}
    </Button></DialogTrigger>
    <DialogContent ref={menuContent} showCloseButton={false} className="docs-navigation-dialog max-h-[85dvh] overflow-y-auto" onOpenAutoFocus={event => {
      const target = menuContent.current?.querySelector<HTMLElement>(kind === "docs" ? 'input[type="search"]' : '.docs-heading-links a');
      if (target) { event.preventDefault(); target.focus(); }
    }} onCloseAutoFocus={event => {
      if (navigatedFromDialog.current) event.preventDefault();
    }}>
      <DialogHeader className="pr-9 text-left"><DialogTitle>{t(kind === "docs" ? "docsMenu" : "onThisPage")}</DialogTitle>
        <DialogDescription>{kind === "docs" ? t("menuDescription") : doc?.title}</DialogDescription>
      </DialogHeader>
      <DialogClose asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeMenu")} className="absolute right-3 top-3"><X aria-hidden="true" /></Button></DialogClose>
      {kind === "docs" ? documentMenu : headingMenu}
    </DialogContent>
  </Dialog>;

  return <div className="docs-layout" data-has-toc={headings.length > 0}>
    <div className="docs-toolbar">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <a href={documentUrl(search, null)} data-doc="" onClick={followDoc} className="docs-home-link"><BookOpen className="size-4" aria-hidden="true" />{t("title")}</a>
        {dialogMenu("docs")}{headings.length > 0 && dialogMenu("headings")}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <label className="sr-only" htmlFor="docs-language">{t("languageLabel")}</label>
        <NativeSelect id="docs-language" size="sm" value={languageChoice} onChange={event => navigate({ docLang: event.target.value === "auto" ? null : event.target.value, docAnchor: null })}>
          <NativeSelectOption value="auto">{t("followInterface")}</NativeSelectOption>
          <NativeSelectOption value="en">English</NativeSelectOption><NativeSelectOption value="zh">中文</NativeSelectOption>
        </NativeSelect>
        {docId && <Button type="button" variant="ghost" size="icon-sm" aria-label={t("refreshArticle")} title={t("refreshArticle")} aria-disabled={docLoad.loading}
          onClick={() => { if (!docLoad.loading) docLoad.retry(); }}><RefreshCw className={docLoad.loading ? "animate-spin" : ""} aria-hidden="true" /></Button>}
      </div>
    </div>
    <aside className="docs-nav" aria-label={t("libraryLabel")}>{documentMenu}</aside>
    <article id="docs-article" ref={article} tabIndex={-1} className="surface docs-article" onClick={followDoc} aria-busy={docId ? docLoad.loading : groupsLoad.loading}>
      {!docId && <>
        <div className="docs-article-header"><h1>{t("overviewTitle")}</h1><p className="text-muted-foreground">{t("overviewBlurb")}</p></div>
        {groupsLoad.error && <ReadNotice title={t("indexFailed")} error={groupsLoad.error} cached={!!groups} loading={groupsLoad.loading} retry={control => retryRead("index", control)} />}
        {!groups && !groupsLoad.error && <p role="status" className="docs-body">{t("loadingTitle")}</p>}
        <div className="docs-body docs-overview-grid">
          {groups?.map(group => <Card key={group.id} className="gap-3 p-5">
            <h2 className="m-0! text-base!">{group.title}</h2><p className="text-sm text-muted-foreground">{group.blurb}</p>
            <div className="docs-overview-links">{group.docs.map(item => <Button key={item.id} asChild variant="link" size="sm" className="h-auto justify-start whitespace-normal px-0 text-left">
              <a href={documentUrl(search, item.id)} data-doc={item.id}>{item.title} →</a>
            </Button>)}</div>
          </Card>)}
        </div>
      </>}
      {docId && docLoad.error && <ReadNotice title={t("articleFailed")} error={docLoad.error} cached={!!doc} loading={docLoad.loading} retry={control => retryRead("article", control)} />}
      {docId && !doc && !docLoad.error && <p role="status" className="docs-body py-8">{t("loadingArticle")}</p>}
      {doc && <>
        <div className="docs-article-header">
          <p className="docs-breadcrumb">{currentGroup?.title ?? t(`groups.${doc.group}`)}<span aria-hidden="true">/</span><span lang={doc.lang}>{doc.lang === "zh" ? "中文" : "English"}</span></p>
          <h1 lang={doc.lang}>{doc.title}</h1>
        </div>
        {doc.fallback && <Alert role="status" className="docs-read-notice"><AlertDescription>{t(doc.lang === "zh" ? "fallbackChinese" : "fallbackEnglish")}</AlertDescription></Alert>}
        {missingAnchor && <Alert role="status" className="docs-read-notice"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1">{t("sectionUnavailable")}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => {
            navigate({ docAnchor: null }); requestAnimationFrame(() => focusArticle(null));
          }}>{t("readFromStart")}</Button>
        </AlertDescription></Alert>}
        <div lang={doc.lang}><DocBody key={`${doc.id}:${doc.lang}`} doc={doc} search={search} /></div>
      </>}
    </article>
    {headings.length > 0 && <aside className="docs-toc"><h2>{t("onThisPage")}</h2>{headingMenu}</aside>}
  </div>;
}
