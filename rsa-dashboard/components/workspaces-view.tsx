"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Copy, Folder, FolderOpen, Plus, RefreshCw, Search, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkspaceCreateForm } from "@/components/workspace-create-form";
import type { WorkspaceCreationIntent } from "@/components/workspace-create-model";
import type { CreateWorkspaceInput, WorkspaceRootResult, WorkspaceRemovalResult, WorkspaceSettings } from "../lib/workspaces";
import type { WorkspaceRegistration } from "../../shared/ludens";
import { useLocale, useTranslations } from "@/lib/locale";
import { useRetryFocus } from "./use-retry-focus";

type DialogKind = "create" | "register" | "root";
type Completion = { kind: "created" | "registered"; entry: WorkspaceRegistration };

async function request<T>(fallback: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/workspaces", {
    method, signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? fallback), { code: value.code });
  return value;
}

export function WorkspacesView({ onChanged, onOpen, catalogError, catalogLoading, onRetryCatalog, createIntent, onCloseCreateIntent }: {
  onChanged(): void; onOpen(id: string): void;
  catalogError?: string; catalogLoading?: boolean; onRetryCatalog?(): void;
  createIntent?: WorkspaceCreationIntent | null;
  onCloseCreateIntent?(): void;
}) {
  const t = useTranslations("workspaceLibrary");
  const { locale } = useLocale();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pageError, setPageError] = useState("");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [initialIntent, setInitialIntent] = useState<WorkspaceCreationIntent | null>(null);
  const handledIntent = useRef<string | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState("");
  const [filter, setFilter] = useState("");
  const [existingPath, setExistingPath] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [removed, setRemoved] = useState<WorkspaceRegistration | null>(null);
  const [alreadyRemoved, setAlreadyRemoved] = useState(false);
  const [savedRoot, setSavedRoot] = useState<string | null>(null);
  const [removalBlocked, setRemovalBlocked] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
  const trigger = useRef<HTMLElement | null>(null);
  const [lastDialog, setLastDialog] = useState<DialogKind>("create");
  const focusCompletion = useRef(false);
  const resultCard = useRef<HTMLDivElement>(null);
  const removedNotice = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const readVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const readFocus = useRetryFocus(loading, loadError);
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (busy.current) return;
    const controller = new AbortController();
    readController.current = controller;
    const version = ++readVersion.current;
    setLoading(true);
    void request<WorkspaceSettings>(t("operationFailed"), "GET", undefined, controller.signal)
      .then(value => {
        if (version === readVersion.current && !controller.signal.aborted) { setSettings(value); setLoadError(""); }
      })
      .catch(error => {
        if (!controller.signal.aborted && version === readVersion.current) setLoadError(String(error.message ?? error));
      })
      .finally(() => {
        if (!controller.signal.aborted && version === readVersion.current) setLoading(false);
      });
    return () => controller.abort();
  }, [loadRevision, t]);
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const requestedPackage = createIntent?.driverPackage;
  const verifiedDriver = createIntent?.driver;
  useEffect(() => {
    if (requestedPackage === undefined) {
      if (handledIntent.current !== null) setDialog(null);
      handledIntent.current = null;
      return;
    }
    if (!settings || handledIntent.current === requestedPackage) return;
    handledIntent.current = requestedPackage;
    trigger.current = createTrigger.current;
    setInitialIntent({ driverPackage: requestedPackage, driver: verifiedDriver });
    setLastDialog("create");
    setActionError("");
    setDialog("create");
  }, [requestedPackage, verifiedDriver, settings]);

  const closeDialog = () => {
    setDialog(null);
    if (createIntent) onCloseCreateIntent?.();
  };

  const openDialog = (kind: DialogKind, element: HTMLElement, path = "") => {
    trigger.current = element;
    setLastDialog(kind);
    focusCompletion.current = false;
    setActionError("");
    setInitialIntent(null);
    setExistingPath(path);
    setWorkspaceRoot(settings?.config.workspaceRoot ?? "");
    setDialog(kind);
  };
  const mutate = async <T,>(label: string, task: () => Promise<T>, accept: (value: T) => void) => {
    if (busy.current) return;
    busy.current = true;
    readVersion.current++;
    readController.current?.abort();
    setLoading(false);
    setPending(label);
    setActionError("");
    setPageError("");
    setRemovalBlocked(false);
    try {
      const value = await task();
      if (mounted.current) {
        // A locale change may have started a read during this write. The
        // committed result must win over every earlier directory snapshot.
        readVersion.current++;
        readController.current?.abort();
        accept(value);
        onChanged();
      }
    } catch (error) {
      if (mounted.current) {
        const message = error instanceof Error ? error.message : String(error);
        setRemovalBlocked((error as { code?: string })?.code === "WORKSPACE_REMOVAL_BLOCKED");
        if (label === "create" || label === "register" || label === "root") setActionError(message);
        else setPageError(message);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending("");
    }
  };
  const acceptEntry = (entry: WorkspaceRegistration, kind: Completion["kind"]) => {
    // The mutation already returns the registered identity. A later list read
    // must not turn a completed creation into an apparent failure.
    setSettings(previous => previous && ({ ...previous, workspaces: [
      { ...entry, available: true }, ...previous.workspaces.filter(item => item.id !== entry.id),
    ] }));
    setFilter("");
    setRemoved(null);
    setAlreadyRemoved(false);
    setSavedRoot(null);
    setCopied("idle");
    setCompletion({ kind, entry });
    focusCompletion.current = true;
    closeDialog();
  };
  const createWorkspace = (input: CreateWorkspaceInput) => {
    void mutate("create", () => request<WorkspaceRegistration>(t("operationFailed"), "POST", { action: "create", workspace: input }),
      entry => acceptEntry(entry, "created"));
  };
  const command = completion ? `rsa --workspace '${completion.entry.workspace.replace(/'/g, "'\\''")}' up` : "";
  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(command); setCopied("done"); }
    catch { setCopied("error"); }
  };
  const matches = settings?.workspaces.filter(entry => `${entry.name}\n${entry.workspace}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];
  const hasEntries = !!settings?.workspaces.length;
  const committed = !!(savedRoot || removed || alreadyRemoved || completion);
  const activeDialog = dialog ?? lastDialog;
  const dialogTitle = activeDialog === "create" ? t("createTitle") : activeDialog === "register" ? t("addTitle") : t("locationTitle");

  return (
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !busy.current) closeDialog(); }}>
      <section className="workspace-library mx-auto grid w-full max-w-6xl gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4 pb-1">
          <div className="space-y-2"><h1>{t("title")}</h1><p className="text-sm leading-relaxed text-muted-foreground">{t("description")}</p></div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" aria-label={t(loading ? "refreshing" : "refreshList")} title={t("refreshList")} aria-disabled={loading || !!pending} className="aria-disabled:opacity-50" onClick={() => {
              if (loading || busy.current) return;
              setLoadRevision(value => value + 1); onRetryCatalog?.();
            }}><RefreshCw /><span className="hidden sm:inline">{t(loading ? "refreshing" : "refreshList")}</span></Button>
            <Button type="button" variant="outline" disabled={!settings || !!pending} onClick={event => openDialog("register", event.currentTarget)}><FolderOpen />{t("addExisting")}</Button>
            <Button ref={createTrigger} type="button" disabled={!settings || !!pending} onClick={event => openDialog("create", event.currentTarget)}><Plus />{t("newWorkspace")}</Button>
          </div>
        </header>

        {savedRoot && <Alert role="status" className="border-success/35 bg-success/5"><CheckCircle2 className="text-success" /><AlertTitle className="line-clamp-none">{t("locationSavedTitle")}</AlertTitle><AlertDescription>
          <p>{t("locationSaved")}</p><p className="break-all font-mono text-xs">{savedRoot}</p>
        </AlertDescription></Alert>}
        {loadError && <Alert variant={committed ? "default" : "destructive"} className={committed ? "border-primary/35 bg-primary/5" : undefined}><AlertTitle className="line-clamp-none">{t(committed ? "refreshFailed" : "loadFailed")}</AlertTitle><AlertDescription>
          {committed && <p>{t("committedReadFailed")}</p>}
          <details className="text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{loadError}</p></details>
          <Button type="button" size="sm" variant="outline" aria-disabled={loading || !!pending} className="aria-disabled:opacity-50" onClick={event => {
            if (loading || busy.current) return;
            readFocus.remember(event.currentTarget); setLoadRevision(value => value + 1);
          }}>{t(loading ? "refreshing" : "retry")}</Button>
        </AlertDescription></Alert>}
        {catalogError && <Alert className="border-primary/35 bg-primary/5"><AlertTitle className="line-clamp-none">{t("catalogRefreshFailed")}</AlertTitle><AlertDescription>
          <p>{t(committed ? "committedReadFailed" : "catalogRetryHint")}</p>
          <details className="text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{catalogError}</p></details>
          <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading || !!pending} className="aria-disabled:opacity-50" onClick={event => {
            if (catalogLoading || busy.current) return;
            catalogFocus.remember(event.currentTarget); onRetryCatalog?.();
          }}>{t(catalogLoading ? "refreshing" : "retryCatalog")}</Button>
        </AlertDescription></Alert>}
        {pageError && <Alert variant="destructive"><AlertTitle className="line-clamp-none">{t(removalBlocked ? "removeNotCompleted" : "operationFailed")}</AlertTitle><AlertDescription>
          <p>{removalBlocked ? t("removeBlockedHint") : pageError}</p>
          {removalBlocked && <details className="text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{pageError}</p></details>}
        </AlertDescription></Alert>}
        {completion && <Card ref={resultCard} role="region" tabIndex={-1} className="gap-3 border-success/35 bg-success/5 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t(completion.kind)}>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /><div className="min-w-0 space-y-1">
              <CardTitle className="text-base">{t(completion.kind)}</CardTitle><p className="text-sm text-muted-foreground">{completion.kind === "created" ? t("createdHint") : t("registeredHint")}</p>
            </div></div>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={t("dismiss")} onClick={() => setCompletion(null)}><X /></Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="break-all font-mono text-xs text-muted-foreground">{completion.entry.workspace}</p>
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => onOpen(completion.entry.id)}>{t("openWorkspace")}<ArrowRight /></Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyCommand()}>{copied === "done" ? <Check /> : <Copy />}{copied === "done" ? t("copied") : t("copyStart")}</Button>
              <Button asChild size="sm" variant="ghost"><a href={`?view=docs&doc=tutorials%2Fquickstart&docLang=${locale}`}>{t("setupGuide")}</a></Button>
            </div>
            {copied === "error" && <p role="alert" className="text-xs text-destructive">{t("copyFailed")}</p>}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("viewCommand")}</summary><code className="mt-2 block select-all break-all rounded-md bg-background p-3">{command}</code></details>
          </CardContent>
        </Card>}
        {removed && <Alert ref={removedNotice} tabIndex={-1} role="status"><AlertDescription className="flex w-full flex-wrap items-center justify-between gap-3">
          <span><strong className="font-medium text-foreground">{removed.name}</strong> · {t("removedHint")}</span>
          <Button ref={undoButton} type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => void mutate("undo", () => request<WorkspaceRegistration>(t("operationFailed"), "POST", { action: "register", workspace: removed.workspace }), entry => {
            acceptEntry(entry, "registered");
            requestAnimationFrame(() => { resultCard.current?.focus(); resultCard.current?.scrollIntoView({ block: "nearest" }); focusCompletion.current = false; });
          })}>{pending === "undo" ? t("restoring") : t("undo")}</Button>
        </AlertDescription></Alert>}
        {alreadyRemoved && <Alert ref={removedNotice} tabIndex={-1} role="status"><AlertDescription>{t("alreadyRemoved")}</AlertDescription></Alert>}

        {!settings ? <Card><CardContent className="py-12 text-center text-sm text-muted-foreground" role="status">{loading ? t("loading") : t("retryHint")}</CardContent></Card> : <>
          <Card ref={node => { readFocus.target.current = node; catalogFocus.target.current = node; }} tabIndex={-1} aria-label={t("collectionTitle")} className="gap-0 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {hasEntries ? <>
              <CardHeader className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-3 text-base">{t("collectionTitle")}<Badge variant="secondary">{settings.workspaces.length}</Badge></CardTitle>
                <div className="relative w-full sm:max-w-80"><Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input className="pl-9" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("search")} aria-label={t("search")} /></div>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-3" aria-label={t("collectionTitle")}>
                  {matches.map(entry => <li key={entry.id} className="rounded-lg border bg-background/35 p-4">
                    <div className="flex flex-wrap items-center gap-4">
                      <div aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Folder className="size-6" /></div>
                      <div className="min-w-0 flex-1 basis-40 space-y-1.5"><strong className="block break-words text-sm font-semibold">{entry.name}</strong><p className="break-all font-mono text-xs leading-relaxed text-muted-foreground">{entry.workspace}</p></div>
                      <Badge variant="outline" className={entry.available ? "border-success/25 bg-success/5 text-success" : "text-muted-foreground"}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{entry.available ? t("available") : t("unavailable")}</Badge>
                      <div className="flex w-full flex-wrap items-center gap-2 min-[1200px]:w-auto">
                        <Button type="button" variant="outline" size="sm" disabled={!!pending || !entry.available} onClick={() => onOpen(entry.id)}>{t("open")}<ArrowRight /></Button>
                        {!entry.available && <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={event => openDialog("register", event.currentTarget, entry.workspace)}>{t("reconnect")}</Button>}
                        <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={!!pending} onClick={() => void mutate(entry.id, () => request<WorkspaceRemovalResult>(t("operationFailed"), "DELETE", { id: entry.id }), value => {
                          setSettings(previous => previous && ({ ...previous, workspaces: previous.workspaces.filter(item => item.id !== entry.id) }));
                          setRemoved(value.removed); setAlreadyRemoved(!value.removed); setCompletion(null); setSavedRoot(null);
                          requestAnimationFrame(() => (undoButton.current ?? removedNotice.current)?.focus());
                        })}>{pending === entry.id ? t("removing") : t("remove")}</Button>
                      </div>
                    </div>
                    {!entry.available && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("unavailableHint")}</p>}
                  </li>)}
                </ul>
                {!matches.length && <div className="space-y-3 py-10 text-center"><p className="text-sm text-muted-foreground">{t("noMatches")}</p><Button type="button" size="sm" variant="outline" onClick={() => setFilter("")}>{t("clearSearch")}</Button></div>}
                <p className="mt-5 border-t pt-4 text-xs leading-relaxed text-muted-foreground">{t("removeHint")}</p>
              </CardContent>
            </> : <CardContent className="flex flex-col items-center py-10 text-center sm:py-16">
              <div aria-hidden="true" className="mb-5 grid size-14 place-items-center rounded-xl bg-primary/10 text-primary"><FolderOpen className="size-7" /></div>
              <h2 className="mb-2 text-xl font-semibold">{t("emptyTitle")}</h2><p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t("emptyHint")}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2"><Button type="button" disabled={!!pending} onClick={event => openDialog("create", event.currentTarget)}><Plus />{t("newWorkspace")}</Button><Button type="button" variant="outline" disabled={!!pending} onClick={event => openDialog("register", event.currentTarget)}>{t("addExisting")}</Button></div>
            </CardContent>}
          </Card>
          <Card className="gap-0"><CardContent className="flex flex-wrap items-center gap-4">
            <Folder aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1 basis-48 space-y-1.5"><h2 className="text-sm font-semibold">{t("locationTitle")}</h2><p className="break-all font-mono text-xs text-muted-foreground">{settings.config.workspaceRoot}</p><p className="text-xs leading-relaxed text-muted-foreground">{t("locationHint")}</p></div>
            <Button type="button" size="sm" variant="outline" disabled={!!pending} onClick={event => openDialog("root", event.currentTarget)}>{t("change")}</Button>
          </CardContent></Card>
        </>}
      </section>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl bg-card sm:max-w-xl" showCloseButton={false}
        onEscapeKeyDown={event => { if (busy.current) event.preventDefault(); }}
        onInteractOutside={event => { if (busy.current) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (focusCompletion.current && resultCard.current) { resultCard.current.focus(); resultCard.current.scrollIntoView({ block: "nearest" }); }
          else trigger.current?.focus();
          focusCompletion.current = false;
        }}>
        <DialogHeader className="pr-6 text-left"><DialogTitle className="text-xl">{dialogTitle}</DialogTitle><DialogDescription className="leading-relaxed">{activeDialog === "create" ? t("createDescription") : activeDialog === "register" ? t("addDescription") : t("locationDescription")}</DialogDescription></DialogHeader>
        {activeDialog === "create" && settings && <WorkspaceCreateForm key={initialIntent?.driverPackage ?? "default"} defaultRoot={settings.config.workspaceRoot} initialIntent={initialIntent} pending={pending === "create"} error={actionError} onSubmit={createWorkspace} onCancel={closeDialog} />}
        {activeDialog === "register" && <form className="grid gap-5" onSubmit={event => {
          event.preventDefault();
          void mutate("register", () => request<WorkspaceRegistration>(t("operationFailed"), "POST", { action: "register", workspace: existingPath.trim() }), entry => acceptEntry(entry, "registered"));
        }}>
          <div className="space-y-2"><Label htmlFor="workspace-existing">{t("pathLabel")}</Label><Input id="workspace-existing" required value={existingPath} disabled={!!pending} onChange={event => setExistingPath(event.target.value)} aria-describedby="workspace-register-hint" placeholder="/Users/you/Ludens/my-workspace" autoComplete="off" spellCheck={false} /><p id="workspace-register-hint" className="text-xs leading-relaxed text-muted-foreground">{t("addHint")}</p></div>
          {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={!!pending} onClick={() => setDialog(null)}>{t("cancel")}</Button><Button type="submit" disabled={!!pending || !existingPath.trim()}>{pending === "register" ? t("adding") : t("addExisting")}</Button></div>
        </form>}
        {activeDialog === "root" && <form className="grid gap-5" onSubmit={event => {
          event.preventDefault();
          void mutate("root", () => request<WorkspaceRootResult>(t("operationFailed"), "PUT", { workspaceRoot: workspaceRoot.trim() }), value => {
            setSettings(previous => previous && ({ ...previous, config: value.config })); setSavedRoot(value.config.workspaceRoot); setDialog(null);
          });
        }}>
          <div className="space-y-2"><Label htmlFor="workspace-root">{t("locationInput")}</Label><Input id="workspace-root" required value={workspaceRoot} disabled={!!pending} onChange={event => setWorkspaceRoot(event.target.value)} aria-describedby="workspace-root-hint" placeholder="/Users/you/Ludens" autoComplete="off" spellCheck={false} /><p id="workspace-root-hint" className="text-xs leading-relaxed text-muted-foreground">{t("locationHint")}</p></div>
          {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={!!pending} onClick={() => setDialog(null)}>{t("cancel")}</Button><Button type="submit" disabled={!!pending || !workspaceRoot.trim() || workspaceRoot.trim() === settings?.config.workspaceRoot}>{pending === "root" ? t("saving") : t("save")}</Button></div>
        </form>}
        <DialogClose asChild><Button type="button" variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label={t("close")} disabled={!!pending}><X /></Button></DialogClose>
      </DialogContent>
    </Dialog>
  );
}
