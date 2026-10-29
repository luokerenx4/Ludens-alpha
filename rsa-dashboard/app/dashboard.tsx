"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, History } from "lucide-react";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project, RunData } from "@/lib/types";
import type { ReplayOverviewResult } from "@/lib/replay-types";
import { initialSelection, latestGameRun } from "@/lib/initial-selection";
import { workspaceRunEntry } from "@/lib/workspace-run-entry";
import { hasSelectedEvidence, latestLiveUrl, liveContext, resolveLiveSelection, type PausedLiveSelection } from "@/lib/live-follow";
import { ReadPoller } from "@/lib/read-poller";
import { WorkspaceRunEmpty } from "@/components/workspace-run-empty";
import { ActivityFeed } from "@/components/activity-feed";
import { useActivityFeed } from "@/components/use-activity-feed";
import { PerceptionSettingsPanel } from "@/components/perception-settings";
import { usePetFollow } from "@/components/pet-follow";
import { ConsoleSidebar, consoleViewIds as viewIds, type ConsoleView as View } from "@/components/console-sidebar";
import { WorkspacePicker, workspaceName } from "@/components/workspace-picker";
import { DesktopBridge } from "@/components/desktop-bridge";
import { BenchmarkCases } from "@/components/benchmark-cases";
import { DocsView } from "@/components/docs-view";
import { CapabilitiesView } from "@/components/capabilities-view";
import { SettingsView } from "@/components/settings-view";
import { DevPanel } from "@/components/dev-panel";
import { TimelinePlayer } from "@/components/timeline-player";
import { replayEvidenceFromSearch, replayEvidencePatch } from "@/components/replay-navigation";
import { ArchiveBuild } from "@/components/archive-build";
import { WorkspacesView } from "@/components/workspaces-view";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverCreationHref } from "@/lib/driver-onboarding";
import {
  Metric,
  ObservationPanel,
  RequestChart,
  RequestDetails,
  seconds,
  percent,
  bytes,
  clockTime,
  requestBytes,
  transport,
} from "@/components/run-visuals";

import { readArchiveJson as json, type ArchiveProgress } from "@/lib/archive-client";
const subscribeLocation = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const getLocation = () => window.location.search;
const serverLocation = () => "";
const runDate = (id: string) => {
  const match = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return match
    ? new Date(
        match[1] + "T" + match[2] + ":" + match[3] + ":" + match[4] + "Z",
      ).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : id;
};
export default function Dashboard() {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const lt = useTranslations("liveContext");
  const search = useSyncExternalStore(
    subscribeLocation,
    getLocation,
    serverLocation,
  );
  const query = new URLSearchParams(search);
  const requestedView = query.get("view");
  const view: View = requestedView && (viewIds as readonly string[]).includes(requestedView) ? requestedView as View : "live";
  const benchmarkCases = view === "benchmark" && query.get("bench") === "cases";
  // Views needing run/epoch context: live, replay and benchmark profiling; other views skip run data.
  const runControls = view === "live" || view === "replay" || (view === "benchmark" && !benchmarkCases);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const refreshCatalog = useCallback(() => setCatalogRevision(value => value + 1), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [verifiedCreationDriver, setVerifiedCreationDriver] = useState<DiscoveredDriver | null>(null);
  useEffect(() => {
    if (view !== "workspaces") setVerifiedCreationDriver(null);
  }, [view]);
  const [loaded, setLoaded] = useState<{ key: string; revision: number; data: RunData } | null>(
    null,
  );
  const [replayCycles, setReplayCycles] = useState<{ key: string; cycles: RunData["cycles"] } | null>(null);
  const onReplayOverview = useCallback((value: ReplayOverviewResult) => {
    setReplayCycles({ key: JSON.stringify([value.project, value.run]), cycles: value.cycles });
  }, []);
  const [runFailure, setRunFailure] = useState<{ key: string; message: string } | null>(null);
  const [preparing, setPreparing] = useState<{ key: string; progress: ArchiveProgress } | null>(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const archiveReady = useCallback(() => setArchiveRevision(value => value + 1), []);
  const [refresh, setRefresh] = useState(true);
  const [pausedSelection, setPausedSelection] = useState<PausedLiveSelection | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [latestRequest, setLatestRequest] = useState<{ revision: number; location: string } | null>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const runPoller = useRef<{ reader: ReadPoller; key: string } | null>(null);
  const [runReading, setRunReading] = useState<{ reader: ReadPoller; key: string } | null>(null);
  const runRetryFocus = useRef<{ control: HTMLButtonElement; key: string } | null>(null);
  const runContent = useRef<HTMLElement>(null);
  const automatic = useRef(refresh);
  automatic.current = refresh;
  const pet = usePetFollow();
  const [stopping, setStopping] = useState(false);
  const [panel, setPanel] = useState("trace");
  const requested = initialSelection(search, projects);
  const requestedLatest = latestGameRun(projects.find(p => p.id === requested.project));
  const followed = resolveLiveSelection({ location: search, project: requested.project, requestedRun: requested.run,
    requestedEpoch: requested.epoch, latestRun: requestedLatest?.id ?? "", refresh, archiveRevision, paused: pausedSelection });
  const selection = { project: followed.project, run: followed.requestedRun, epoch: followed.epoch };
  const project = projects.find((p) => p.id === selection.project);
  const latest = latestGameRun(project);
  const run = followed.run;
  // A URL change is intentional navigation even while paused. Latch its new default
  // before the next catalog poll can replace it; an empty workspace stays empty too.
  if (!refresh && catalogReady && !followed.frozen) {
    setPausedSelection({ location: search, project: selection.project, run, requestedRun: selection.run, epoch: selection.epoch, archiveRevision });
  }
  const entry = workspaceRunEntry({ catalogReady, catalogError, project, run });
  const scopeKey = selection.project + "/" + run + "/" + selection.epoch;
  const beforeCall = query.get("beforeCall") ?? "";
  const requestedCall = query.get("call") ?? "";
  const selectedImage = query.get("image") ?? undefined;
  const key = JSON.stringify([scopeKey, beforeCall, requestedCall, selectedImage]);
  const error = runFailure?.key === key ? runFailure.message : "";
  const data = loaded?.key === key ? loaded.data : null;
  const cycles = view === "replay"
    ? replayCycles?.key === JSON.stringify([selection.project, run]) ? replayCycles.cycles : []
    : data?.cycles ?? [];
  const activity = useActivityFeed({ project: selection.project, run, epoch: selection.epoch || undefined,
    enabled: view === "live", refresh, archiveRevision, resetRevision: snapshotRevision, selectedBlock: query.get("block") ?? undefined });
  const call =
    data?.selectedCall ?? data?.calls.find((c) => c.id === requestedCall) ?? data?.calls.at(-1);
  const navigateUrl = useCallback((target: string) => {
    const url = new URL(target, window.location.href);
    if (url.origin !== window.location.origin) return;
    const next = url.pathname + url.search;
    if (next === window.location.pathname + window.location.search) return;
    window.history.pushState(null, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const navigate = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(patch))
      value ? params.set(name, value) : params.delete(name);
    navigateUrl("/?" + params.toString());
  };
  const createWithDriver = (driver: DiscoveredDriver) => {
    setVerifiedCreationDriver(driver);
    navigateUrl(driverCreationHref(driver.spec));
  };
  const closeCreateIntent = () => {
    setVerifiedCreationDriver(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("create"); params.delete("driverPackage");
    window.history.replaceState(null, "", "/?" + params.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const toggleRefresh = () => {
    if (refresh) setPausedSelection({ location: search, project: selection.project, run, requestedRun: selection.run, epoch: selection.epoch, archiveRevision });
    setRefresh(value => !value);
  };
  const returnToLatest = () => {
    const target = latestLiveUrl(selection.project);
    const revision = snapshotRevision + 1;
    // The explicit revision matters when the URL is already clean and polling is off.
    setSnapshotRevision(revision);
    returnFocus.current = document.activeElement === returnButton.current;
    setLatestRequest({ revision, location: target.slice(1) });
    setRunFailure(null);
    if (!refresh) setPausedSelection({ location: target.slice(1), project: selection.project, run: latest?.id ?? "", requestedRun: "", epoch: "", archiveRevision });
    navigateUrl(target);
  };
  const viewLink = (id: View) => {
    const params = new URLSearchParams(query);
    params.set("view", id);
    if (id !== "workspaces") { params.delete("create"); params.delete("driverPackage"); }
    if (id !== "replay" && params.get("epoch") === "all") params.delete("epoch");
    return "?" + params.toString();
  };
  const pinned = {
    project: selection.project,
    run,
    epoch: data?.selectedEpoch ?? selection.epoch,
  };
  const selectCall = (id: string) =>
    navigate({ ...pinned, call: id, image: null, block: null });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setCatalogLoading(true);
      try {
        const value = await json<Project[]>("/api/catalog?includeEmpty=1", controller.signal);
        if (controller.signal.aborted) return;
        setProjects(value);
        setCatalogError("");
      } catch (e) {
        if (!controller.signal.aborted) setCatalogError(String(e));
      } finally {
        if (!controller.signal.aborted) {
          setCatalogReady(true);
          setCatalogLoading(false);
          timer = setTimeout(load, 10000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [catalogRevision]);
  useEffect(() => {
    if (view === "workspaces" || view === "settings" || view === "dev" || benchmarkCases || view === "replay" || view === "docs" || view === "caps" || view === "perception" || !selection.project || !run) return;
    const params = new URLSearchParams({
      project: selection.project,
      run,
      ...(selection.epoch ? { epoch: selection.epoch } : {}),
      ...(beforeCall ? { beforeCall } : {}),
      ...(requestedCall ? { call: requestedCall } : {}),
      ...(selectedImage ? { image: selectedImage } : {}),
    });
    const reader = new ReadPoller(async signal => {
      setRunReading({ reader, key });
      try {
        const next = await json<RunData>(
          "/api/run?" + params,
          signal,
          progress => setPreparing({ key, progress }),
        );
        if (signal.aborted) return 2500;
        setLoaded({ key, revision: snapshotRevision, data: next });
        setPreparing(null);
        setRunFailure(null);
      } catch (e) {
        if (!signal.aborted) setRunFailure({ key, message: String(e) });
      } finally {
        if (!signal.aborted && runPoller.current?.reader === reader) setRunReading(null);
      }
      return 2500;
    }, automatic.current);
    runPoller.current = { reader, key };
    void reader.readOnce();
    return () => {
      reader.dispose();
      if (runPoller.current?.reader === reader) runPoller.current = null;
    };
  }, [
    selection.project,
    run,
    selection.epoch,
    beforeCall,
    requestedCall,
    selectedImage,
    key,
    view,
    benchmarkCases,
    followed.archiveRevision,
    snapshotRevision,
  ]);
  useEffect(() => { runPoller.current?.reader.setEnabled(refresh); }, [refresh]);
  const retryingRun = runReading?.key === key && runReading.reader === runPoller.current?.reader;
  const retryRun = (control: HTMLButtonElement) => {
    const pending = runPoller.current;
    if (!pending || pending.key !== key || retryingRun) return;
    runRetryFocus.current = document.activeElement === control ? { control, key } : null;
    void pending.reader.readOnce();
  };
  useEffect(() => {
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !runRetryFocus.current?.control.contains(event.target)) runRetryFocus.current = null;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release);
    return () => { document.removeEventListener("focusin", release); document.removeEventListener("pointerdown", release); };
  }, []);
  useEffect(() => {
    const pending = runRetryFocus.current;
    if (!pending) return;
    if (view !== "live" || pending.key !== key) { runRetryFocus.current = null; return; }
    if (retryingRun) return;
    runRetryFocus.current = null;
    if (!error && !pending.control.isConnected && document.activeElement === document.body)
      runContent.current?.focus({ preventScroll: true });
  }, [view, key, error, retryingRun]);
  const live = data?.live;
  const isCurrent =
    !!data && live?.runId === data.run && data.selectedEpoch === live?.epoch;
  const auto = isCurrent && live?.connected && live.mode === "auto";
  const returned =
    !!data &&
    live?.runId === data.run &&
    live.connected &&
    live.mode === "manual" &&
    data.selectedEpoch === data.cycles.at(-1)?.epoch;
  const phase = auto ? data?.livePhase : null;
  const status =
    phase?.label ??
    (auto
      ? dt("statusTakingOver")
      : data
        ? returned || (isCurrent && live?.connected)
          ? dt("statusReturned")
          : dt("statusReplay")
        : dt("statusWaiting"));
  const context = data ? liveContext({
    run: data.run,
    latestRun: latest?.id ?? "",
    selectedEpoch: data.selectedEpoch,
    latestEpoch: data.cycles.at(-1)?.epoch ?? null,
    selectedEvidence: hasSelectedEvidence(search),
    historicalLog: activity.historical,
    live: data.live,
  }) : null;
  const latestReadsDone = loaded?.key === key && loaded.revision === snapshotRevision
    && activity.loadedRevision === snapshotRevision && !activity.loading;
  const latestScopeMatches = activity.scope?.project === selection.project && activity.scope?.runId === run
    && activity.scope?.epoch === data?.selectedEpoch;
  const latestReady = latestReadsDone && latestScopeMatches;
  const latestRequested = latestRequest?.revision === snapshotRevision && latestRequest.location === search;
  const latestScopeChanged = latestRequested && latestReadsDone && !latestScopeMatches
    && !error && !activity.error;
  const latestFailed = latestRequested && !!(error || activity.error || latestScopeChanged);
  const returningLatest = latestRequested && !latestFailed
    && !latestReady;
  useEffect(() => {
    if (latestRequest && !latestRequested) {
      returnFocus.current = false;
      setLatestRequest(null);
    } else if (latestRequested && (latestReady || latestFailed)) {
      if (returnFocus.current && (document.activeElement === document.body || document.activeElement === returnButton.current))
        returnButton.current?.focus({ preventScroll: true });
      returnFocus.current = false;
      if (!latestFailed) setLatestRequest(null);
    }
  }, [latestRequest, latestRequested, latestReady, latestFailed]);
  useEffect(() => {
    if (!latestRequested) return;
    const preserveUserFocus = (event: Event) => {
      if (event.target !== returnButton.current && event.target !== document.body)
        returnFocus.current = false;
    };
    document.addEventListener("focusin", preserveUserFocus);
    document.addEventListener("pointerdown", preserveUserFocus);
    return () => {
      document.removeEventListener("focusin", preserveUserFocus);
      document.removeEventListener("pointerdown", preserveUserFocus);
    };
  }, [latestRequested]);
  const contextTitles = { latest: "titleLatest", run: "titleRun", epoch: "titleEpoch", evidence: "titleEvidence", log: "titleLog" };
  const hostLabels = { auto: "hostAuto", manual: "hostManual", disconnected: "hostDisconnected", unavailable: "hostUnavailable", historical: "hostHistorical" };
  const observedStatus = context ? lt(hostLabels[context.host]) : status;
  const staleStatus = !refresh || !!error || returningLatest || latestFailed;
  const stop = async () => {
    if (!data?.controlAllowed || !auto) return;
    setStopping(true);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: data.project,
          run: data.run,
          epoch: data.selectedEpoch,
          action: "off",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? dt("handoverFailed"));
      const next = await json<RunData>(
        "/api/run?" +
          new URLSearchParams({
            project: data.project,
            run: data.run,
            ...(data.selectedEpoch ? { epoch: data.selectedEpoch } : {}),
            ...(beforeCall ? { beforeCall } : {}),
            ...(requestedCall ? { call: requestedCall } : {}),
            ...(selectedImage ? { image: selectedImage } : {}),
          }),
      );
      setLoaded({ key, revision: snapshotRevision, data: next });
      setRunFailure(null);
    } catch (e) {
      setRunFailure({ key, message: String(e) });
    } finally {
      setStopping(false);
    }
  };
  const s = data?.summary;
  const waitSummary = [
    s?.medianHttpHeadersMs != null ? dt("waitHttp") + " " + seconds(s.medianHttpHeadersMs) : "",
    s?.medianWsWaitMs != null ? dt("waitWs") + " " + seconds(s.medianWsWaitMs) : "",
  ].filter(Boolean).join(" · ");
  const pageRange = data?.calls.length ? `Page #${data.paging.firstIndex}–#${data.paging.lastIndex} · ${data.paging.totalCalls} ${dt("requestsUnit")}` : dt("pageEmpty");
  const hasTelemetry = data?.telemetry.sources.some(
    (source) => source.component !== "unlabelled",
  );
  const metrics = data ? (
    <section className={view === "live" ? "metrics live-metrics" : "metrics"} aria-label={dt("roundSummary")}>
      <Metric label={dt("metric.completed")} value={String(s!.completed)} detail={dt("metric.totalPrefix") + data.paging.totalCalls + dt("requestsUnit")} />
      {view === "live" ? <Metric label={dt("metric.actions")} value={String(s!.actions)} detail={s!.explicitObserves + dt("metric.observes")} />
        : <Metric label={dt("metric.p95")} value={seconds(s!.p95Ms)} detail={dt("metric.nearestRank")} />}
      <Metric label={dt("metric.median")} value={seconds(s!.medianMs)} detail={waitSummary || dt("metric.noWait")} />
      <Metric label={dt("metric.cache")} value={percent(s!.cacheHit)} detail={dt("metric.afterFirst") + percent(s!.warmCacheHit)} />
    </section>
  ) : null;
  return (
    <div className="console-shell">
      <DesktopBridge onNavigate={navigateUrl} />
      <ConsoleSidebar projects={projects} view={view} viewLink={viewLink} onNavigate={navigateUrl} pet={pet}
        petProject={benchmarkCases || view === "docs" || view === "settings" || view === "workspaces" ? undefined : project}
        onPetSettings={() => navigate({ view: "settings" })} />
      <div className="console-main">
        <header className={"context-bar" + (view === "live" ? " live-context-bar" : "")}>
          <div className="context-workspace">
            <WorkspacePicker projects={projects} value={selection.project} loading={!catalogReady} error={catalogError}
              onChange={id => navigate({ project: id, workspace: null, run: null, epoch: null,
                beforeCall: null, call: null, block: null, image: null, at: null, ...replayEvidencePatch(null),
                case: null, caseDigest: null, result: null, baseline: null, verification: null,
                baselineVerification: null, report: null, baselineReport: null,
                verificationCursor: null, evidenceCursor: null, benchCursor: null })} />
            <div className="breadcrumb"><i>/</i><strong>{t(`nav.${view}`)}</strong></div>
          </div>
          <div className="context-controls">
            {runControls && (
              <>
                <NativeSelect
                  aria-label={dt("runHistoryLabel")}
                  className="max-w-60 text-xs"
                  disabled={!project?.runs.length}
                  value={!refresh && !selection.run ? run : selection.run}
                  onChange={(e) =>
                    !e.target.value && view === "live" ? returnToLatest() : navigate({
                      run: e.target.value,
                      epoch: null,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null, ...replayEvidencePatch(null),
                    })
                  }
                >
                  <NativeSelectOption value="">
                    {latest ? dt("latestRun") : t("workspaceRunEmpty.noGameRuns")}
                    {latest
                      ? " · " + runDate(latest.id)
                      : ""}
                  </NativeSelectOption>
                  {project?.runs.map((r) => (
                    <NativeSelectOption key={r.id} value={r.id}>
                      {runDate(r.id)}
                      {r.kind === "benchmark" ? dt("benchSuffix") : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label={dt("epochLabel")}
                  className="max-w-48 text-xs"
                  disabled={!run}
                  value={!refresh && !selection.epoch ? data?.selectedEpoch ?? "" : selection.epoch}
                  onChange={(e) => {
                    setPausedSelection(null);
                    if (!e.target.value && !selection.epoch) setSnapshotRevision(value => value + 1);
                    navigate({
                      project: selection.project,
                      run,
                      epoch: e.target.value,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null, ...replayEvidencePatch(null),
                    });
                  }}
                >
                  <NativeSelectOption value="">
                    {data?.manifest.kind === "benchmark" && !cycles.length
                      ? dt("fullBenchRun")
                      : dt("latestEpoch")}
                    {cycles.length ? " · #" + cycles.length : ""}
                  </NativeSelectOption>
                  {view === "replay" && <NativeSelectOption value="all">{dt("allEpochs")}</NativeSelectOption>}
                  {[...cycles].reverse().map((c, i) => (
                    <NativeSelectOption key={c.epoch} value={c.epoch}>
                      #{cycles.length - i} · {clockTime(c.startedAt)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </>
            )}
            {(run || benchmarkCases) && (view === "live" || view === "benchmark") && <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-muted-foreground"
              aria-pressed={refresh}
              title={lt("refreshHint")}
              onClick={toggleRefresh}
            >
              <i className="status-dot" />
              {lt(refresh ? "autoRefreshOn" : "autoRefreshOff")}
            </Button>}
          </div>
        </header>
        <main ref={runContent} tabIndex={view === "live" ? -1 : undefined} className={"page-content" + (view === "live" ? " live-page" : "")}>
          {view !== "workspaces" && view !== "docs" && view !== "perception" && view !== "caps" && (view !== "replay" || entry !== "ready") && <div className={"page-heading" + (view === "live" ? " live-page-heading" : view === "settings" ? " mx-auto w-full max-w-5xl" : "")}>
            <div>
              <h1>{benchmarkCases ? t("benchmark.casesTitle") : t(`views.${view}.title`)}</h1>
              <p>
                {benchmarkCases ? t("benchmark.casesDescription") : t(`views.${view}.description`)}
              </p>
            </div>
            {data && (view === "live" || (view === "benchmark" && !benchmarkCases)) && (
              <Button
                type="button"
                variant="outline"
                disabled={!data?.controlAllowed || !auto || stopping}
                title={data?.controlReason ?? dt("noRun")}
                onClick={stop}
              >
                {stopping ? dt("handingOver") : dt("handover")}
              </Button>
            )}
          </div>}
          {view === "benchmark" && (
            <nav className="mb-5 flex gap-2 border-b pb-3" aria-label={dt("benchNavLabel")}>
              {[
                ["analysis", dt("benchAnalysis")],
                ["cases", dt("benchCases")],
              ].map(([tab, title]) => (
                <Button
                  type="button"
                  size="sm"
                  key={tab}
                  aria-pressed={benchmarkCases === (tab === "cases")}
                  variant={benchmarkCases === (tab === "cases") ? "secondary" : "ghost"}
                  onClick={() =>
                    navigate({ bench: tab === "cases" ? "cases" : null })
                  }
                >
                  {title}
                </Button>
              ))}
            </nav>
          )}
          {runControls && run && <ArchiveBuild key={selection.project + "/" + run}
            project={selection.project} run={run} onReady={archiveReady} />}
          {runControls && entry !== "catalog-error" && (catalogError || (view !== "replay" && error)) && (
            <Alert variant="destructive" className="mb-5"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 break-words">{catalogError || error}
              {data && (
                <small>{dt("keepLast")} · {clockTime(data.updatedAt)}</small>
              )}</span>
              <div className="flex flex-wrap gap-2">
                {catalogError && <Button type="button" size="sm" variant="outline" disabled={catalogLoading} onClick={refreshCatalog}>
                  {t(catalogLoading ? "workspaceRunEmpty.retrying" : "workspaceRunEmpty.retry")}
                </Button>}
                {view === "live" && error && <Button type="button" size="sm" variant="outline" aria-disabled={retryingRun}
                  className="aria-disabled:opacity-50" onClick={event => retryRun(event.currentTarget)}>
                  {lt(retryingRun ? "readingRun" : "retryRun")}
                </Button>}
              </div>
            </AlertDescription></Alert>
          )}
          {view === "live" && entry === "ready" && (context || latestRequested) && <section
            className={"live-context-banner "
              + ((context?.kind ?? "latest") === "latest" ? "border-border bg-card" : "border-primary/40 bg-primary/5")}
            aria-labelledby="live-context-title"
          >
            <History className="live-context-icon size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="live-context-copy">
              <h2 id="live-context-title" className="text-sm font-semibold" aria-live="polite">
                {returningLatest ? lt("returning") : lt(contextTitles[(context?.kind ?? "latest")])}
              </h2>
              {data && <p className="live-context-checked">{lt("lastChecked")} {clockTime(data.updatedAt)}</p>}
              <p className={(latestScopeChanged || latestFailed ? "live-context-error" : "live-context-description")}>
                {latestScopeChanged ? lt("scopeChanged") : latestFailed ? lt("refreshFailed") : lt("detail")}
              </p>
            </div>
            <Button ref={returnButton} type="button" size="sm" variant={(context?.kind ?? "latest") === "latest" ? "outline" : "default"}
              className="shrink-0" onClick={returnToLatest} disabled={returningLatest || !latest}>
              {lt("returnLatest")} <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </section>}
          {view === "workspaces" ? (
            <WorkspacesView onChanged={refreshCatalog} onOpen={id => navigateUrl("/?" + new URLSearchParams({ view: "caps", project: id }))}
              catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              createIntent={query.get("create") === "1" ? { driverPackage: query.get("driverPackage") ?? "",
                driver: verifiedCreationDriver?.spec === query.get("driverPackage") ? verifiedCreationDriver : undefined } : null}
              onCloseCreateIntent={closeCreateIntent} />
          ) : view === "settings" ? (
            <SettingsView follow={pet} projects={projects} />
          ) : view === "dev" ? (
            <DevPanel navigate={navigate} />
          ) : view === "perception" ? (
            <PerceptionSettingsPanel project={selection.project} projects={projects}
              ready={catalogReady} catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : view === "docs" ? (
            <DocsView search={search} navigate={navigate} />
          ) : view === "caps" ? (
            <CapabilitiesView project={selection.project} ready={catalogReady} catalogError={catalogError}
              workspace={project?.workspace ?? null} onCreateWithDriver={createWithDriver} onNavigate={navigateUrl}
              catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : runControls && entry !== "ready" ? (
            <WorkspaceRunEmpty state={entry} project={project?.id} workspaceName={workspaceName(project)}
              benchmarkRun={project?.runs.find(r => r.kind === "benchmark" || r.benchmark)?.id}
              error={catalogError} retrying={catalogLoading} onRetry={refreshCatalog} onNavigate={navigateUrl} />
          ) : view === "replay" ? (
            <TimelinePlayer key={scopeKey} project={selection.project} run={run} epoch={selection.epoch || "latest"}
              onOverview={onReplayOverview} archiveRevision={archiveRevision}
              position={query.get("at")} evidence={replayEvidenceFromSearch(search)}
              onPosition={(at, evidence = null) => navigate({ project: selection.project, run, at: String(at), ...replayEvidencePatch(evidence) })}
              onEvidence={evidence => navigate(replayEvidencePatch(evidence))} />
          ) : benchmarkCases ? (
            <BenchmarkCases
              workspace={selection.project}
              ready={catalogReady}
              workspaceAvailable={project?.available !== false}
              catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              search={search}
              refresh={refresh}
              navigate={navigate}
              onNavigate={navigateUrl}
            />
          ) : !data ? (
            <section className="surface empty-state main-empty">
              <span className="empty-symbol">◫</span>
              <h2>
                {error ? dt("empty.readFailed")
                  : preparing?.key === key ? dt("empty.archiving") : dt("empty.loadingRun")}
              </h2>
              <p>
                {error ? view === "live" ? lt("readFailureHint") : dt("emptyHint.checkService")
                      : preparing?.key === key
                        ? `${dt("archive.read")} ${bytes(preparing.progress.bytes)} / ${bytes(preparing.progress.totalBytes)}${preparing.progress.projection ? ` · ${dt("archive.organizedPrefix")}${preparing.progress.projection.position.toLocaleString()} / ${preparing.progress.projection.total.toLocaleString()}${dt("archive.organizedSuffix")}` : ""}${dt("archive.replayNote")}`
                        : dt("emptyHint.loadingObs")}
              </p>
            </section>
          ) : (
            <>
              <div className={"run-status" + (view === "live" ? " live-host-status" : "")}>
                <span className={"status-dot " + (auto && !staleStatus ? "online" : "")} />
                <strong>{view === "live" ? <>{staleStatus && `${lt("hostSnapshot")}: `}{observedStatus}</> : status}</strong>
                {view === "live" && phase?.label && !staleStatus && <span>{phase.label}</span>}
                {phase?.elapsedMs != null && !staleStatus && (
                  <span>{dt("elapsed")} {seconds(phase.elapsedMs)}</span>
                )}
                {view !== "live" && <><i />
                <span>{data.manifest.model ?? dt("deviceOnly")}</span>
                <span className="run-time">
                  {Math.floor(s!.elapsedSeconds / 60)}{dt("min")}{" "}
                  {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} <b> / </b>{dt("budget")}{" "}
                  {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}
                </span></>}
              </div>
              {view !== "live" && metrics}
              {view === "live" ? (
                <>
                <div className="live-grid">
                  <div className="live-observation">
                    <ObservationPanel
                      priority
                      data={data}
                      call={call}
                      selectedImage={selectedImage}
                      onImage={(id) => navigate({ ...pinned, image: id })}
                    />
                  </div>
                  <ActivityFeed
                    key={scopeKey + "/" + data.selectedEpoch}
                    feed={activity}
                    expectedEpoch={data.selectedEpoch}
                    selectedBlock={query.get("block") ?? undefined}
                    onSelect={(block) =>
                      navigate({
                        ...pinned,
                        block: block.id,
                        call: block.trace?.modelCallId ?? null,
                        image: null,
                      })
                    }
                  />
                </div>
                <details className="surface live-run-details">
                  <summary><span>{lt("runDetails")}</span><span className="live-run-summary">{s!.completed} {dt("requestsUnit")} · {seconds(s!.medianMs)}</span></summary>
                  <div className="live-run-details-content">
                    <p className="live-run-context-help">{lt("detail")}</p>
                    <dl className="live-run-facts">
                      <div><dt>{lt("model")}</dt><dd>{data.manifest.model ?? dt("deviceOnly")}</dd></div>
                      <div><dt>{dt("elapsed")}</dt><dd>{Math.floor(s!.elapsedSeconds / 60)}{dt("min")} {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} / {dt("budget")} {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}</dd></div>
                      <div><dt>{lt("drivers")}</dt><dd>{data.manifest.drivers.map(driver => driver.id).join(" · ") || "—"}</dd></div>
                    </dl>
                    {metrics}
                    <Button type="button" variant="ghost" size="xs"
                      className="h-auto justify-start whitespace-normal text-left text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => navigate({ view: "benchmark" })}>
                      {dt("checkPerf")} ↗
                    </Button>
                  </div>
                </details>
                </>
              ) : (
                <>
                  <section className="charts">
                    {(["latency", "cache", "body"] as const).map((type) => (
                      <div className="surface chart-card" key={type}>
                        <div className="surface-heading">
                          <h2>
                            {type === "latency"
                              ? dt("chart.latency")
                              : type === "cache"
                                ? dt("chart.cache")
                                : dt("chart.body")}
                          </h2>
                          <span>
                            {type === "latency"
                              ? dt("chart.latencyHint")
                              : type === "cache"
                                ? "%"
                                : dt("chart.bodyHint")}
                          </span>
                        </div>
                        <RequestChart
                          type={type}
                          calls={data.calls}
                          selected={call?.id}
                          onSelect={selectCall}
                        />
                      </div>
                    ))}
                  </section>
                  <div className="benchmark-grid">
                    <section className="surface request-timeline">
                      <div className="surface-heading">
                        <h2>{dt("timeline")}</h2>
                        <Button type="button" variant="ghost" size="xs"
                          className="h-auto justify-start whitespace-normal text-left text-xs text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            navigate({ beforeCall: null, call: null, image: null, block: null })
                          }
                        >
                          {dt("followLatest")} ↓
                        </Button>
                      </div>
                      <p className="feed-notice">{pageRange}</p>
                      <div className="timeline-list">
                        {[...data.calls]
                          .reverse()
                          .map((c) => (
                            <button type="button"
                              key={c.id}
                              className={
                                "request-row" +
                                (c.id === call?.id ? " selected" : "")
                              }
                              aria-pressed={c.id === call?.id}
                              onClick={() => selectCall(c.id)}
                            >
                              <div>
                                <b>#{String(c.index).padStart(3, "0")}</b>
                                <span className={"request-state " + c.status}>
                                  {c.status === "pending"
                                    ? dt("req.pending")
                                    : c.status === "error"
                                      ? dt("req.failed")
                                      : c.status === "aborted"
                                        ? dt("req.aborted")
                                        : seconds(c.durationMs)}
                                </span>
                              </div>
                              <p>
                                {c.tools[0]?.intent ||
                                  c.tools.map((t) => t.name).join(" · ") ||
                                  (c.status === "pending"
                                    ? dt("req.waiting")
                                    : dt("req.textReply"))}
                              </p>
                              <small>
                                {clockTime(c.at)} <span>{transport(c, (key) => t(`runVisuals.${key}`))}</span>
                              </small>
                              <small>
                                {bytes(requestBytes(c))}
                                <span>{percent(c.cacheHit)}</span>
                              </small>
                            </button>
                          ))}
                        {data.paging.hasMore && data.paging.beforeCall !== null && (
                          <Button type="button" variant="ghost" size="xs" className="load-more text-muted-foreground"
                            onClick={() => navigate({ ...pinned, beforeCall: String(data.paging.beforeCall), call: null, image: null, block: null })}>
                            {dt("loadMore")}
                          </Button>
                        )}
                        {!data.calls.length && (
                          <div className="empty-state">
                            <p>
                              {data.activeCompaction
                                ? dt("callsEmpty.compacting")
                                : data.selectedEpoch
                                  ? dt("callsEmpty.noEpochCalls")
                                  : data.manifest.benchmark
                                    ? dt("callsEmpty.noBenchCalls")
                                    : dt("callsEmpty.noTakeover")}
                            </p>
                          </div>
                        )}
                      </div>
                    </section>
                    <RequestDetails
                      data={data}
                      call={call}
                      panel={panel}
                      onPanel={setPanel}
                      onSelect={selectCall}
                      onInspect={() =>
                        navigate({
                          ...pinned,
                          view: "live",
                          call: call?.id ?? null,
                        })
                      }
                    />
                  </div>
                  <section className="surface telemetry-summary">
                    <div>
                      <h2>{dt("telemetry.title")}</h2>
                      <p>{dt("telemetry.hint")}</p>
                    </div>
                    <div className="source-chips">
                      {data.telemetry.sources.map((source) => (
                        <span key={source.component}>
                          <i className={"source-dot " + source.component} />
                          {source.component}
                          <b>{source.count.toLocaleString()}</b>
                        </span>
                      ))}
                    </div>
                    <div className="telemetry-counts">
                      <span>
                        {dt("telemetry.nativeLoops")}{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.shiori.nativeLoops.length
                            : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.capCalls")}{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.capabilities.stats.started
                            : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.devOps")}{" "}
                        <b>
                          {hasTelemetry ? data.telemetry.devices.started : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.errors")} <b>{s!.errors}</b>
                      </span>
                      <span>
                        {dt("telemetry.compactions")} <b>{s!.compactions}</b>
                      </span>
                    </div>
                  </section>
                  <details className="run-provenance">
                    <summary>{dt("provenance.title")}</summary>
                    <dl className="fact-grid">
                      <div>
                        <dt>Shiori</dt>
                        <dd>
                          {data.manifest.shiori?.implementation ?? dt("provenance.unrecorded")}{" "}
                          {data.manifest.shiori?.implementationVersion}
                        </dd>
                      </div>
                      <div>
                        <dt>{dt("provenance.compactThresh")}</dt>
                        <dd>
                          {data.manifest.compactionThreshold?.toLocaleString() ??
                            dt("provenance.default")}
                        </dd>
                      </div>
                      <div>
                        <dt>Workspace</dt>
                        <dd>{data.manifest.workspace}</dd>
                      </div>
                      <div>
                        <dt>Run</dt>
                        <dd>{data.run}</dd>
                      </div>
                      <div>
                        <dt>Epoch</dt>
                        <dd>
                          {data.selectedEpoch ??
                            (data.manifest.benchmark
                              ? dt("provenance.fullRun")
                              : dt("provenance.notTaken"))}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      {dt("provenance.notePrefix")}{pageRange}{dt("provenance.noteSuffix")}
                    </p>
                  </details>
                </>
              )}
              <footer className="page-footer">
                <span>
                  ⓘ{" "}
                  {view === "live"
                    ? dt("footer.live")
                    : dt("footer.bench")}
                </span>
                <span>{dt("updatedAt")} {clockTime(data.updatedAt)}</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
