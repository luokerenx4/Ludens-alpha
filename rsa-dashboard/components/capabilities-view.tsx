"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, BookOpen, Box, CheckCircle2, FileCode2, ListChecks, Monitor } from "lucide-react";
import type { CapabilityEntry, CapabilitiesResult, CapabilityRuntime } from "@/lib/capabilities";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverCreationHref } from "@/lib/driver-onboarding";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useLocale, useTranslations } from "@/lib/locale";
import { useReadResource } from "./use-read-resource";
import { useRetryFocus } from "./use-retry-focus";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface WorkspaceCatalogProps {
  project: string;
  workspace: string | null;
  ready: boolean;
  catalogError?: string;
  catalogLoading?: boolean;
  onRetryCatalog(): void;
  onCreateWithDriver(driver: DiscoveredDriver): void;
  onNavigate(href: string): void;
}
function NavigationLink({ href, onNavigate, children, primary = false }: {
  href: string; onNavigate(href: string): void; children: ReactNode; primary?: boolean;
}) {
  return <Button asChild variant={primary ? "default" : "outline"} size="sm" className="h-auto min-h-8 max-w-full whitespace-normal py-2 text-left">
    <a href={href} onClick={event => { if (isPlainNavigationClick(event)) { event.preventDefault(); onNavigate(href); } }}>{children}</a>
  </Button>;
}
function useGuideHref(project: string) {
  const { locale } = useLocale();
  return (doc: string) => "/?" + new URLSearchParams({ view: "docs", doc, docLang: locale, ...(project ? { project } : {}) });
}

function DiscoverDriver({ project, onCreateWithDriver, onNavigate }: Pick<WorkspaceCatalogProps, "project" | "onCreateWithDriver" | "onNavigate">) {
  const t = useTranslations("capabilitiesView"), guide = useGuideHref(project);
  const [spec, setSpec] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiscoveredDriver | null>(null);
  const [failure, setFailure] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { const controller = request.current; request.current = null; controller?.abort(); }, []);
  const changeSpec = (value: string) => {
    const controller = request.current; request.current = null; controller?.abort();
    setSpec(value); setPending(false); setResult(null); setFailure("");
  };
  const discover = async () => {
    if (request.current || !spec.trim()) return;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setFailure(""); setResult(null);
    try {
      const response = await fetch("/api/drivers/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: spec.trim() }), signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? t("readFailed"));
      if (!controller.signal.aborted && request.current === controller) setResult(value as DiscoveredDriver);
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); }
    }
  };
  return <Card className="min-w-0" aria-label={t("driverSectionLabel")} data-driver-verification>
    <CardContent className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3">
        <Box className="size-5 shrink-0 text-primary" /><h2 className="text-base font-semibold">{t("driverTitle")}</h2>
      </div><Badge variant="outline">{t("onDemandBadge")}</Badge></div>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("discoverNote1a")}<code>github:org/repo#rev</code>{t("discoverNote1b")}<code>{t("examplePath")}</code>{t("discoverNote1c")}</p>
      <form className="flex flex-wrap items-center gap-3" onSubmit={event => { event.preventDefault(); void discover(); }}>
        <Input className="min-w-0 basis-60 flex-1" value={spec} onChange={event => changeSpec(event.target.value)} placeholder={t("specPlaceholder")}
          aria-label={t("specAriaLabel")} aria-describedby="driver-import-boundary" spellCheck={false} />
        <Button type="submit" aria-disabled={pending || !spec.trim()} className="aria-disabled:opacity-50">{pending ? t("verifying") : t("verifyDriver")}</Button>
      </form>
      <p id="driver-import-boundary" className="text-xs leading-relaxed text-muted-foreground">{t("discoverNote2a")}<code>load()</code>{t("discoverNote2b")}</p>
      {failure && <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>}
      {result && <div className="space-y-4 rounded-lg border border-primary/25 bg-primary/5 p-4" data-verified-driver>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row"><div className="min-w-0 w-full flex-1 space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold" role="status"><CheckCircle2 className="size-4 shrink-0 text-primary" />{t("verifiedTitle")}</h3>
          <p className="break-all font-mono text-xs">{result.spec}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline">{result.id}</Badge><span>{t("declaredVersion")}: {result.version}</span>
            {result.transport && <span>{result.transport}</span>}{result.defaultPort !== undefined && <span>{t("defaultPortPrefix")}{result.defaultPort}</span>}</div>
        </div><Button asChild className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left">
          <a href={driverCreationHref(result.spec)} onClick={event => {
            if (isPlainNavigationClick(event)) { event.preventDefault(); onCreateWithDriver(result); }
          }}>{t("createWithDriver")}<ArrowUpRight /></a>
        </Button></div>
        {result.launchHint && <p className="break-words text-xs leading-relaxed text-muted-foreground">{result.launchHint}</p>}
        <div className="space-y-2 border-t border-border/70 pt-3 text-xs leading-relaxed text-muted-foreground"><p>{t("verifiedBoundary")}</p><p>{t("creationRechecks")}</p></div>
      </div>}
      <div className="flex flex-wrap items-center gap-3 border-t pt-4"><NavigationLink href={guide("tutorials/devices")} onNavigate={onNavigate}><BookOpen />{t("deviceGuide")}</NavigationLink>
        <p className="min-w-0 flex-1 basis-72 text-xs leading-relaxed text-muted-foreground">{t("existingWorkspaceHint")}</p></div>
    </CardContent>
  </Card>;
}

function CapabilityTable({ items }: { items: CapabilityEntry[] }) {
  const t = useTranslations("capabilitiesView");
  return <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top">
    <TableHeader className="bg-muted/40"><TableRow><TableHead>{t("capabilityCol")}</TableHead><TableHead>{t("descriptionCol")}</TableHead><TableHead>{t("controlCol")}</TableHead></TableRow></TableHeader>
    <TableBody>{items.map(item => <TableRow key={item.id}>
      <TableCell className="min-w-40"><code>{item.id}</code></TableCell>
      <TableCell className="min-w-64 whitespace-normal">{item.description || <span className="text-muted-foreground">{t("noDescription")}</span>}</TableCell>
      <TableCell>{item.requiresControl === null ? "—" : t(item.requiresControl ? "needsControl" : "noControl")}{item.readOnly !== null && t(item.readOnly ? "readOnlySuffix" : "sideEffectsSuffix")}</TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

function ConnectionCheck({ project, workspace }: { project: string; workspace: string }) {
  const t = useTranslations("capabilitiesView");
  const [value, setValue] = useState<CapabilityRuntime | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), request = useRef<AbortController | null>(null);
  useEffect(() => () => { const controller = request.current; request.current = null; controller?.abort(); }, []);
  const check = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/capabilities/runtime?" + new URLSearchParams({ project, workspace }),
        { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("runtimeReadFailed"));
      if (request.current === controller && !controller.signal.aborted) { setValue(result); setError(""); }
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setLoading(false); } }
  };
  const status = loading ? "runtimeChecking" : error ? value ? "runtimeStale" : "runtimeReadFailed" : !value ? "runtimeUnchecked" : value.host === "unavailable" ? "runtimeUnavailable"
    : value.controlConnected === null ? "runtimeUnknown" : value.controlConnected ? "runtimeConnected" : "runtimeDisconnected";
  return <Card className="min-w-0" data-capability-runtime><CardContent className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><Activity className="size-5 text-primary" /><h2 className="text-base font-semibold">{t("runtimeTitle")}</h2></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={loading} className="aria-disabled:opacity-50" onClick={() => void check()}>{t(loading ? "runtimeChecking" : "checkRuntime")}</Button></div>
    <p role="status" className="text-sm">{t(status)}</p><p className="text-xs leading-relaxed text-muted-foreground">{t("runtimeReadOnly")}</p>
    {error && <Alert variant="destructive"><AlertDescription>{t("runtimeReadFailed")}<details className="mt-2 text-xs"><summary>{t("errorDetails")}</summary><p className="mt-2 break-all">{error}</p></details></AlertDescription></Alert>}
    {value && <div className="space-y-1 text-xs text-muted-foreground"><p>{t("checkedAt")} <time dateTime={value.checkedAt}>{new Date(value.checkedAt).toLocaleString()}</time></p>
      {value.runId && <p className="break-all">{t("hostRunLabel")}: <code>{value.runId}</code></p>}</div>}
  </CardContent></Card>;
}

function WorkspaceCapabilities({ project, workspace, ready, catalogError, catalogLoading, onRetryCatalog, onNavigate }: WorkspaceCatalogProps) {
  const t = useTranslations("capabilitiesView"), guide = useGuideHref(project);
  const capsLoad = useReadResource<CapabilitiesResult>(project && workspace ? "/api/capabilities?" + new URLSearchParams({ project, workspace }) : null, t("readFailed"));
  const caps = capsLoad.value;
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);
  const links = { device: { doc: "tutorials/devices", label: "deviceGuide" }, workspace: { doc: "tutorials/workspace", label: "capabilityGuide" }, tasks: { doc: "reference/benchmark", label: "benchmarkGuide" } };
  return <div ref={catalogFocus.target} className="grid min-w-0 grid-cols-1 gap-5" tabIndex={-1} role="region" aria-label={t("overviewLabel")} aria-busy={capsLoad.loading}>
    <header className="space-y-2"><h2 className="text-lg font-semibold">{t("sourcesTitle")}</h2><p className="text-sm leading-relaxed text-muted-foreground">{t("sourcesDescription")}</p></header>
    {catalogError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><p>{t("catalogFailed")}</p><details className="mt-1 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{catalogError}</pre></details></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading} className="aria-disabled:opacity-50" onClick={event => { if (!catalogLoading) { catalogFocus.remember(event.currentTarget); onRetryCatalog(); } }}>{t(catalogLoading ? "retrying" : "retryCatalog")}</Button></AlertDescription></Alert>}
    {project && workspace && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{t("readOnlyRefreshHint")}</p>
      <Button type="button" size="sm" variant="outline" aria-disabled={capsLoad.loading} className="aria-disabled:opacity-50" onClick={() => { if (!capsLoad.loading) capsLoad.retry(); }}>{t(capsLoad.loading ? "retrying" : capsLoad.error ? "retryRead" : "refresh")}</Button></div>}
    {capsLoad.error && <Alert variant="destructive"><AlertDescription><p>{t("loadErrorTitle")}</p><details className="mt-1 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{capsLoad.error}</pre></details>{caps && <p className="mt-1">{t("showingCached")}</p>}</AlertDescription></Alert>}
    {!caps ? !ready || capsLoad.loading ? <Card><CardContent role="status"><h3 className="text-sm font-semibold">{t(!ready ? "loadingWorkspaces" : "loadingTitle")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("loadingDesc")}</p></CardContent></Card>
      : !catalogError && !capsLoad.error ? <Card><CardContent className="space-y-4"><h3 className="text-base font-semibold">{t("emptyTitle")}</h3><p className="text-sm text-muted-foreground">{t("emptyDesc")}</p><div className="flex flex-wrap gap-2">
        <NavigationLink href="/?view=workspaces&create=1" onNavigate={onNavigate} primary>{t("createWorkspace")}</NavigationLink><NavigationLink href="/?view=workspaces" onNavigate={onNavigate}>{t("viewWorkspaces")}</NavigationLink></div></CardContent></Card> : null : <>
      {(["device", "workspace", "tasks"] as const).map(id => {
        const source = caps.sources[id], items = caps.groups.find(group => group.id === id)?.items ?? [];
        const count = id === "tasks" ? caps.tasks.length : items.length;
        const countLabel = source.status === "error" || source.status === "missing" ? "—" : String(count);
        const Icon = id === "device" ? Monitor : id === "workspace" ? FileCode2 : ListChecks;
        return <Card key={id} className="min-w-0" data-capability-source={id}><CardContent className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-2"><h3 className="flex items-center gap-3 text-base font-semibold"><Icon className="size-5 shrink-0 text-primary" />{t(`groupTitles.${id}`)}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{t(`sourceStates.${source.status}`)}</Badge><span>{countLabel} {t(id === "tasks" ? "taskPackagesUnit" : "capabilitiesUnit")}</span></div></div>
            <NavigationLink href={guide(links[id].doc)} onNavigate={onNavigate}><BookOpen />{t(links[id].label)}</NavigationLink></div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t(`sourceDescriptions.${id}`)}</p>
          {id === "device" && caps.deviceSnapshot && <div className="space-y-1 text-xs text-muted-foreground">
            <p>{caps.deviceSnapshot.generatedAt ? <>{t("snapshotAt")} <time dateTime={caps.deviceSnapshot.generatedAt}>{new Date(caps.deviceSnapshot.generatedAt).toLocaleString()}</time></> : t("snapshotTimeUnknown")}</p>
            {caps.deviceSnapshot.drivers.length > 0 && <p className="break-words">{t("recordedDrivers")}: {caps.deviceSnapshot.drivers.map(driver => `${driver.id}${driver.version ? ` (${driver.version})` : ""}`).join(", ")}</p>}</div>}
          {source.status === "error" ? <p className="text-sm text-destructive">{t("sourceFailure")}</p> : count === 0 ? <p className="text-sm text-muted-foreground">{t(`sourceEmpty.${id}`)}</p>
            : id !== "tasks" ? <CapabilityTable items={items} /> : <Table className="text-xs [&_th]:px-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top"><TableHeader className="bg-muted/40"><TableRow><TableHead>{t("taskCol")}</TableHead><TableHead>{t("descriptionCol")}</TableHead><TableHead>{t("versionCol")}</TableHead></TableRow></TableHeader>
              <TableBody>{caps.tasks.map(task => <TableRow key={`${task.name}@${task.digest}`}><TableCell className="min-w-40"><code>{task.name}</code></TableCell><TableCell className="min-w-64 whitespace-normal">{task.title !== task.name ? task.title : t("noDescription")}</TableCell><TableCell><code>{task.digest.slice(0, 20)}…</code></TableCell></TableRow>)}</TableBody></Table>}
          {source.issueCount > 0 && <p className="text-xs text-muted-foreground">{t("diagnosticsTitle")}: {source.issueCount}</p>}
          {id === "tasks" && <NavigationLink href={"/?" + new URLSearchParams({ view: "benchmark", bench: "cases", project })} onNavigate={onNavigate}>{t("viewBenchmark")}<ArrowUpRight /></NavigationLink>}
        </CardContent></Card>;
      })}
      {caps.issues.length > 0 && <details className="rounded-lg border p-4 text-xs"><summary className="cursor-pointer">{t("diagnosticsTitle")} ({caps.issues.length})</summary><div className="mt-3 space-y-2">{caps.issues.map((issue, index) => <p key={index} className="break-all">{issue.error}</p>)}</div></details>}
      <p className="text-xs text-muted-foreground">{t("checkedAt")} <time dateTime={caps.checkedAt}>{new Date(caps.checkedAt).toLocaleString()}</time></p>
    </>}
    {project && workspace && <ConnectionCheck key={JSON.stringify([project, workspace])} project={project} workspace={workspace} />}
  </div>;
}

export function CapabilitiesView(props: WorkspaceCatalogProps) {
  const t = useTranslations("capabilitiesView");
  return <div className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-6"><header className="space-y-2"><h1>{t("title")}</h1><p className="text-sm leading-relaxed text-muted-foreground">{t("description")}</p></header>
    <DiscoverDriver project={props.project} onCreateWithDriver={props.onCreateWithDriver} onNavigate={props.onNavigate} />
    <WorkspaceCapabilities {...props} />
  </div>;
}
