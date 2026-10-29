"use client";
import { useEffect, useRef, useState } from "react";
import type { CapabilityEntry, CapabilitiesResult } from "@/lib/capabilities";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverInitCommand } from "@/lib/driver-command";
import { useTranslations } from "@/lib/locale";
import { useReadResource } from "./use-read-resource";
import { useRetryFocus } from "./use-retry-focus";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface WorkspaceCatalogProps {
  project: string;
  ready: boolean;
  catalogError?: string;
  catalogLoading?: boolean;
  onRetryCatalog(): void;
}

function DiscoverDriver() {
  const t = useTranslations("capabilitiesView");
  const [spec, setSpec] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiscoveredDriver | null>(null);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const changeSpec = (value: string) => {
    request.current?.abort();
    request.current = null;
    setSpec(value); setPending(false); setResult(null); setFailure(""); setCopied("");
  };
  const discover = async () => {
    if (request.current || !spec.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setFailure(""); setResult(null); setCopied("");
    try {
      const response = await fetch("/api/drivers/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: spec.trim() }), signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? t("readFailed"));
      if (!controller.signal.aborted) setResult(value as DiscoveredDriver);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  };
  const command = result ? driverInitCommand(result) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(command); setFailure(""); }
    catch { setCopied(""); setFailure(t("copyFailed")); }
  };
  return <section className="surface" aria-label={t("driverSectionLabel")}>
    <div className="surface-heading"><h2>{t("driverTitle")}</h2><Badge variant="outline">{t("onDemandBadge")}</Badge></div>
    <div className="caps-section">
      <p className="bench-note">{t("discoverNote1a")}<code>github:org/repo#rev</code>{t("discoverNote1b")}<code>{t("examplePath")}</code>{t("discoverNote1c")}</p>
      <p className="bench-note">{t("discoverNote2a")}<code>load()</code>{t("discoverNote2b")}</p>
      <form className="caps-discover-row" onSubmit={event => { event.preventDefault(); void discover(); }}>
        <Input className="min-w-0 basis-60 flex-1" value={spec} onChange={event => changeSpec(event.target.value)} placeholder={t("specPlaceholder")}
          aria-label={t("specAriaLabel")} spellCheck={false} />
        <Button type="submit" variant="outline" disabled={pending || !spec.trim()}>
          {pending ? t("verifying") : t("verifyDriver")}
        </Button>
      </form>
      {failure ? <Alert variant="destructive" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert> : null}
      {result ? <div className="caps-discover-result">
        <p className="bench-note">{t("verifiedPrefix")}<code>{result.spec}</code></p>
        <p><code>{result.id}</code> · {result.version}{result.transport ? ` · ${result.transport}` : ""}{result.defaultPort !== undefined ? `${t("defaultPortPrefix")}${result.defaultPort}` : ""}{result.needsGame ? t("needsGameNote") : ""}</p>
        {result.launchHint ? <p className="bench-note">{result.launchHint}</p> : null}
        <div className="bench-command">
          <code>{command}</code>
          <Button type="button" variant="outline" size="sm" onClick={copy}>{copied === command ? t("copiedLabel") : t("copyInitCommand")}</Button>
        </div>
      </div> : null}
    </div>
  </section>;
}
function WorkspaceCapabilities({ project, ready, catalogError, catalogLoading, onRetryCatalog }: WorkspaceCatalogProps) {
  const t = useTranslations("capabilitiesView");
  const controlLabel = (item: CapabilityEntry) => item.requiresControl === null ? "—"
    : item.requiresControl ? t("needsControl") : t("noControl");
  const readOnlyLabel = (item: CapabilityEntry) => item.readOnly === null ? ""
    : item.readOnly ? t("readOnlySuffix") : t("sideEffectsSuffix");
  const capsLoad = useReadResource<CapabilitiesResult>(project ? `/api/capabilities?project=${encodeURIComponent(project)}` : null, t("readFailed"));
  const caps = capsLoad.value;
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);
  return <div ref={catalogFocus.target} className="caps-layout" tabIndex={-1} role="region" aria-label={t("overviewLabel")} aria-busy={capsLoad.loading}>
    {catalogError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1"><p>{t("catalogFailed")}</p><details className="mt-1 text-xs">
        <summary className="cursor-pointer">{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{catalogError}</pre>
      </details></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading} className="aria-disabled:opacity-50"
        onClick={event => { if (!catalogLoading) { catalogFocus.remember(event.currentTarget); onRetryCatalog(); } }}>{t(catalogLoading ? "retrying" : "retryCatalog")}</Button>
    </AlertDescription></Alert>}
    {project && <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">{t("readOnlyRefreshHint")}</p>
      <Button type="button" size="sm" variant="outline" aria-disabled={capsLoad.loading} className="aria-disabled:opacity-50"
        onClick={() => { if (!capsLoad.loading) capsLoad.retry(); }}>
        {t(capsLoad.loading ? "retrying" : capsLoad.error ? "retryRead" : "refresh")}
      </Button>
    </div>}
    {capsLoad.error && <Alert variant="destructive"><AlertDescription>
      <p>{t("loadErrorTitle")}</p><details className="mt-1 text-xs">
        <summary className="cursor-pointer">{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{capsLoad.error}</pre>
      </details>
      {caps && <p className="mt-1">{t("showingCached")}</p>}
    </AlertDescription></Alert>}
    {!caps?.project ? !ready || (project && capsLoad.loading) ? <section className="surface empty-state" role="status">
      <h2>{t(!ready && !project ? "loadingWorkspaces" : "loadingTitle")}</h2>
      {project && <p>{t("loadingDesc")}</p>}
    </section> : !catalogError && !capsLoad.error ? <section className="surface empty-state">
      <h2>{t("emptyTitle")}</h2><p>{t("emptyDesc")}</p>
    </section> : null : <>
    {caps.issues.length > 0 && <details className="bench-warning"><summary>{t("diagnosticsTitle")}</summary>
      {caps.issues.map((issue, index) => <p key={index}>{issue.error}</p>)}
    </details>}
    <section className="metrics" aria-label={t("overviewLabel")}>
      {caps.groups.map(group => <div className="metric" key={group.id}>
        <span>{group.title}</span><strong>{group.items.length}</strong><small>{t("capabilitiesUnit")}</small>
      </div>)}
      <div className="metric"><span>{t("tasksMetricLabel")}</span><strong>{caps.tasks.length}</strong><small>{t("taskPackagesUnit")}</small></div>
    </section>
    {caps.groups.map(group => <section className="surface" key={group.id} aria-label={group.title}>
      <div className="surface-heading"><h2>{group.title}</h2><span>{group.items.length}{t("itemsUnit")}</span></div>
      {group.items.length ? <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top">
        <TableHeader className="bg-muted/40"><TableRow><TableHead>{t("capabilityCol")}</TableHead><TableHead>{t("descriptionCol")}</TableHead><TableHead>{t("controlCol")}</TableHead></TableRow></TableHeader>
        <TableBody>{group.items.map(item => <TableRow key={item.id}>
          <TableCell className="min-w-40"><code>{item.id}</code></TableCell>
          <TableCell className="min-w-64 whitespace-normal">{item.description || <span className="text-muted-foreground">{t("noDescription")}</span>}</TableCell>
          <TableCell>{controlLabel(item)}{readOnlyLabel(item)}</TableCell>
        </TableRow>)}</TableBody>
      </Table> : <p className="bench-note">{t("noGroupsHint")}</p>}
    </section>)}
    <section className="surface" aria-label={t("tasksSectionLabel")}>
      <div className="surface-heading"><h2>{t("benchmarkTitle")}</h2><span>{caps.tasks.length}{t("tasksUnit")}</span></div>
      {caps.tasks.length ? <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top">
        <TableHeader className="bg-muted/40"><TableRow><TableHead>{t("taskCol")}</TableHead><TableHead>{t("descriptionCol")}</TableHead><TableHead>{t("versionCol")}</TableHead></TableRow></TableHeader>
        <TableBody>{caps.tasks.map(task => <TableRow key={`${task.name}@${task.digest}`}>
          <TableCell className="min-w-40"><code>{task.name}</code></TableCell>
          <TableCell className="min-w-64 whitespace-normal">{task.title !== task.name ? task.title : <span className="text-muted-foreground">{t("noDescription")}</span>}</TableCell>
          <TableCell><code>{task.digest.slice(0, 20)}…</code></TableCell>
        </TableRow>)}</TableBody>
      </Table> : <p className="bench-note">{t("noTasksHint")}</p>}
    </section>
  </>}
  </div>;
}

export function CapabilitiesView(props: WorkspaceCatalogProps) {
  return <div className="caps-layout">
    <WorkspaceCapabilities {...props} />
    <DiscoverDriver />
  </div>;
}
