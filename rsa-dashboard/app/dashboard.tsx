"use client";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project, RunData } from "@/lib/types";
import type { ReplayOverviewResult } from "@/lib/replay-types";
import { initialSelection, latestGameRun } from "@/lib/initial-selection";
import { ActivityFeed } from "@/components/activity-feed";
import { useActivityFeed } from "@/components/use-activity-feed";
import { PerceptionSettingsPanel } from "@/components/perception-settings";
import { PetFollowCard, usePetFollow } from "@/components/pet-follow";
import { DesktopBridge } from "@/components/desktop-bridge";
import { BenchmarkCases } from "@/components/benchmark-cases";
import { DocsView } from "@/components/docs-view";
import { CapabilitiesView } from "@/components/capabilities-view";
import { SettingsView } from "@/components/settings-view";
import { DevPanel } from "@/components/dev-panel";
import { TimelinePlayer } from "@/components/timeline-player";
import { ArchiveBuild } from "@/components/archive-build";
import { WorkspacesView } from "@/components/workspaces-view";
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
const viewIds = ["live", "replay", "benchmark", "caps", "perception", "workspaces", "docs", "settings", "dev"] as const;
type View = typeof viewIds[number];
const navSections: Array<{ label: string; ids: View[] }> = [
  { label: "navSectionWorkspace", ids: ["live", "replay", "benchmark", "caps", "perception"] },
  { label: "navSectionGlobal", ids: ["workspaces", "docs", "settings"] },
  { label: "navSectionDev", ids: ["dev"] },
];
function workspaceName(project?: Project, fallback = "") {
  if (!project) return fallback;
  if (project.name) return project.name;
  if (project.workspace) {
    const parts = project.workspace.split("/").filter(Boolean);
    return (
      (parts.at(-1) === "workspace" ? parts.at(-2) : parts.at(-1)) ?? project.id
    );
  }
  return project.id;
}
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
function NavIcon({ kind }: { kind: View | "logo" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === "logo" ? (
        <>
          <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
          <path d="m3 7 9 5 9-5M12 12v10" />
        </>
      ) : kind === "live" ? (
        <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />
      ) : kind === "replay" ? (
        <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /><path d="m10 8 6 4-6 4Z" /></>
      ) : kind === "workspaces" ? (
        <><path d="M3 7h7l2-3h9v16H3Z" /><path d="M8 13h8M12 9v8" /></>
      ) : kind === "docs" ? (
        <>
          <path d="M5 3h11l3 3v15H5Z" /><path d="M9 9h7M9 13h7M9 17h4" />
        </>
      ) : kind === "caps" ? (
        <>
          <path d="M9 3H5v18h14V3h-4" /><path d="M9 3h6v4H9Z" /><path d="m9 16 2 2 4-4" />
        </>
      ) : kind === "perception" ? (
        <>
          <circle cx="12" cy="12" r="3.4" /><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        </>
      ) : kind === "benchmark" ? (
        <>
          <path d="M4 19V11M10 19V5M16 19V8M22 19V2" strokeWidth="3" />
        </>
      ) : kind === "dev" ? (
        <>
          <path d="m4 17 5-5-5-5" /><path d="M12 19h8" />
        </>
      ) : (
        <>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
        </>
      )}
    </svg>
  );
}

export default function Dashboard() {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const search = useSyncExternalStore(
    subscribeLocation,
    getLocation,
    serverLocation,
  );
  const query = new URLSearchParams(search);
  const requestedView = query.get("view");
  const view: View = requestedView && (viewIds as readonly string[]).includes(requestedView) ? requestedView as View : "live";
  const benchmarkCases = view === "benchmark" && query.get("bench") === "cases";
  const includeEmptyProjects = ["caps", "perception", "settings", "workspaces"].includes(view);
  // Views needing run/epoch context: live, replay and benchmark profiling; other views skip run data.
  const runControls = view === "live" || view === "replay" || (view === "benchmark" && !benchmarkCases);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const refreshCatalog = useCallback(() => setCatalogRevision(value => value + 1), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; data: RunData } | null>(
    null,
  );
  const [replayCycles, setReplayCycles] = useState<{ key: string; cycles: RunData["cycles"] } | null>(null);
  const onReplayOverview = useCallback((value: ReplayOverviewResult) => {
    setReplayCycles({ key: JSON.stringify([value.project, value.run]), cycles: value.cycles });
  }, []);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState<{ key: string; progress: ArchiveProgress } | null>(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const archiveReady = useCallback(() => setArchiveRevision(value => value + 1), []);
  const [refresh, setRefresh] = useState(true);
  const pet = usePetFollow();
  const [stopping, setStopping] = useState(false);
  const [panel, setPanel] = useState("trace");
  const selection = initialSelection(search, projects);
  const project = projects.find((p) => p.id === selection.project);
  const latest = latestGameRun(project);
  const run = selection.run || latest?.id || "";
  const scopeKey = selection.project + "/" + run + "/" + selection.epoch;
  const beforeCall = query.get("beforeCall") ?? "";
  const requestedCall = query.get("call") ?? "";
  const selectedImage = query.get("image") ?? undefined;
  const key = JSON.stringify([scopeKey, beforeCall, requestedCall, selectedImage]);
  const data = loaded?.key === key ? loaded.data : null;
  const cycles = view === "replay"
    ? replayCycles?.key === JSON.stringify([selection.project, run]) ? replayCycles.cycles : []
    : data?.cycles ?? [];
  const activity = useActivityFeed({ project: selection.project, run, epoch: selection.epoch || undefined,
    enabled: view === "live", refresh, archiveRevision, selectedBlock: query.get("block") ?? undefined });
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
  const viewLink = (id: View) => {
    const params = new URLSearchParams(query);
    params.set("view", id);
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
      try {
        const value = await json<Project[]>(includeEmptyProjects ? "/api/catalog?includeEmpty=1" : "/api/catalog", controller.signal);
        setProjects(value);
        setCatalogError("");
      } catch (e) {
        if (!controller.signal.aborted) setCatalogError(String(e));
      } finally {
        if (!controller.signal.aborted) {
          setCatalogReady(true);
          timer = setTimeout(load, 10000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [includeEmptyProjects, catalogRevision]);
  useEffect(() => {
    if (view === "workspaces" || view === "settings" || view === "dev" || benchmarkCases || view === "replay" || view === "docs" || view === "caps" || view === "perception" || !selection.project || !run) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({
      project: selection.project,
      run,
      ...(selection.epoch ? { epoch: selection.epoch } : {}),
      ...(beforeCall ? { beforeCall } : {}),
      ...(requestedCall ? { call: requestedCall } : {}),
      ...(selectedImage ? { image: selectedImage } : {}),
    });
    const load = async () => {
      try {
        const next = await json<RunData>(
          "/api/run?" + params,
          controller.signal,
          progress => setPreparing({ key, progress }),
        );
        if (controller.signal.aborted) return;
        setLoaded({ key, data: next });
        setPreparing(null);
        setError("");

      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        if (!controller.signal.aborted && refresh)
          timer = setTimeout(load, 2500);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    selection.project,
    run,
    selection.epoch,
    beforeCall,
    requestedCall,
    selectedImage,
    key,
    refresh,
    view,
    benchmarkCases,
    archiveRevision,
  ]);
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
      setLoaded({ key, data: next });
      setError("");
    } catch (e) {
      setError(String(e));
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
  return (
    <div className="console-shell">
      <DesktopBridge onNavigate={navigateUrl} />
      <aside className="sidebar">
        <a
          className="brand"
          href="?view=live"
          onClick={(e) => {
            e.preventDefault();
            navigate({ view: "live" });
          }}
        >
          <NavIcon kind="logo" />
          <span>Ludens</span>
        </a>
        <div className="workspace-picker">
          <label htmlFor="workspace">
            {benchmarkCases ? dt("picker.benchAcross") : view === "docs" ? dt("picker.docsSource") : view === "settings" ? dt("picker.globalSettings") : view === "workspaces" ? dt("picker.workspacesAdmin") : dt("picker.workspace")}
          </label>
          {view === "workspaces" ? (
            <div className="bench-global-workspace">{dt("picker.localWorkspaces")}</div>
          ) : benchmarkCases ? (
            <div className="bench-global-workspace">{dt("picker.allWorkspaces")}</div>
          ) : view === "docs" ? (
            <div className="bench-global-workspace">{dt("picker.repoDocs")}</div>
          ) : view === "settings" ? (
            <div className="bench-global-workspace">{dt("picker.sharedDesktopWeb")}</div>
          ) : (
            <NativeSelect
              id="workspace"
              className="w-full text-xs"
              wrapperClassName="w-full"
              value={selection.project}
              onChange={(e) =>
                navigate({
                  project: e.target.value,
                  workspace: null,
                  run: null,
                  epoch: null,
                  beforeCall: null,
                  call: null,
                  block: null,
                  image: null,
                  at: null,
                })
              }
            >
              {!projects.length && <NativeSelectOption value="">{dt("picker.noWorkspace")}</NativeSelectOption>}
              {projects.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {workspaceName(p)}{p.available === false ? dt("picker.unavailable") : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
        <nav aria-label={dt("consoleNav")}>
          {navSections.map(section => (
            <div key={section.label} className="nav-section">
              <small>{t(section.label)}</small>
              {section.ids.map(id => (
                <a
                  key={id}
                  href={viewLink(id)}
                  className={view === id ? "active" : ""}
                  aria-current={view === id ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigateUrl(viewLink(id));
                  }}
                >
                  <NavIcon kind={id} />
                  <span>{t(`nav.${id}`)}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <PetFollowCard follow={pet} project={benchmarkCases || view === "docs" || view === "settings" || view === "workspaces" ? undefined : project}
          onSettings={() => navigate({ view: "settings" })} />
      </aside>
      <div className="console-main">
        <header className="context-bar">
          <div className="breadcrumb">
            <span>
              {benchmarkCases ? dt("picker.allWorkspaces") : view === "docs" || view === "settings" || view === "workspaces" ? "Ludens" : workspaceName(project, dt("workspacePlaceholder"))}
            </span>
            <i>/</i>
            <strong>{t(`nav.${view}`)}</strong>
          </div>
          <div className="context-controls">
            {runControls && (
              <>
                <NativeSelect
                  aria-label={dt("runHistoryLabel")}
                  className="max-w-60 text-xs"
                  value={selection.run}
                  onChange={(e) =>
                    navigate({
                      run: e.target.value,
                      epoch: null,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null,
                    })
                  }
                >
                  <NativeSelectOption value="">
                    {dt("latestRun")}
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
                  value={selection.epoch}
                  onChange={(e) =>
                    navigate({
                      project: selection.project,
                      run,
                      epoch: e.target.value,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null,
                    })
                  }
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
            {(view === "live" || view === "benchmark") && <Button
              type="button"
              size="sm"
              variant="outline"
              className={refresh ? "border-success/40 text-success" : "text-muted-foreground"}
              aria-pressed={refresh}
              title={dt("refreshHint")}
              onClick={() => setRefresh((v) => !v)}
            >
              <i className={"status-dot" + (refresh ? " online" : "")} />
              {refresh ? dt("live") : dt("paused")}
            </Button>}
          </div>
        </header>
        <main className="page-content">
          <div className="page-heading">
            <div>
              <h1>{benchmarkCases ? t("benchmark.casesTitle") : t(`views.${view}.title`)}</h1>
              <p>
                {benchmarkCases ? t("benchmark.casesDescription") : t(`views.${view}.description`)}
              </p>
            </div>
            {(view === "live" || (view === "benchmark" && !benchmarkCases)) && (
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
          </div>
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
          {runControls && <ArchiveBuild key={selection.project + "/" + run}
            project={selection.project} run={run} onReady={archiveReady} />}
          {runControls && (catalogError || (view !== "replay" && error)) && (
            <div className="error-banner" role="alert">
              {catalogError || error}
              {data && (
                <small>{dt("keepLast")} · {clockTime(data.updatedAt)}</small>
              )}
            </div>
          )}
          {view === "workspaces" ? (
            <WorkspacesView onChanged={refreshCatalog} onOpen={id => navigate({ view: "caps", project: id, workspace: null, run: null, epoch: null, call: null, block: null, image: null })} />
          ) : view === "settings" ? (
            <SettingsView follow={pet} projects={projects} />
          ) : view === "dev" ? (
            <DevPanel navigate={navigate} />
          ) : view === "perception" ? (
            <PerceptionSettingsPanel key={selection.project} project={selection.project} projects={projects} />
          ) : view === "docs" ? (
            <DocsView search={search} navigate={navigate} />
          ) : view === "caps" ? (
            <CapabilitiesView project={selection.project} ready={catalogReady} catalogError={catalogError} />
          ) : view === "replay" ? (
            <TimelinePlayer key={scopeKey} project={selection.project} run={run} epoch={selection.epoch || "latest"}
              onOverview={onReplayOverview} archiveRevision={archiveRevision}
              position={query.get("at")} onPosition={at => navigate({ project: selection.project, run, at: String(at) })} />
          ) : benchmarkCases ? (
            <BenchmarkCases
              search={search}
              refresh={refresh}
              navigate={navigate}
              onNavigate={navigateUrl}
            />
          ) : !data ? (
            <section className="surface empty-state main-empty">
              <span className="empty-symbol">◫</span>
              <h2>
                {!catalogReady
                  ? dt("empty.discovering")
                  : !projects.length
                    ? dt("empty.noRuns")
                    : error
                      ? dt("empty.readFailed")
                      : preparing?.key === key ? dt("empty.archiving") : dt("empty.loadingRun")}
              </h2>
              <p>
                {!catalogReady
                  ? dt("emptyHint.connecting")
                  : !projects.length
                    ? dt("emptyHint.startRsa")
                    : error
                      ? dt("emptyHint.checkService")
                      : preparing?.key === key
                        ? `${dt("archive.read")} ${bytes(preparing.progress.bytes)} / ${bytes(preparing.progress.totalBytes)}${preparing.progress.projection ? ` · ${dt("archive.organizedPrefix")}${preparing.progress.projection.position.toLocaleString()} / ${preparing.progress.projection.total.toLocaleString()}${dt("archive.organizedSuffix")}` : ""}${dt("archive.replayNote")}`
                        : dt("emptyHint.loadingObs")}
              </p>
              {!projects.length && <Button type="button" onClick={() => navigate({ view: "workspaces" })}>{dt("manageWorkspaces")}</Button>}
            </section>
          ) : (
            <>
              <div className="run-status">
                <span className={"status-dot " + (auto ? "online" : "")} />
                <strong>{status}</strong>
                {phase?.elapsedMs != null && (
                  <span>{dt("elapsed")} {seconds(phase.elapsedMs)}</span>
                )}
                <i />
                <span>{data.manifest.model ?? dt("deviceOnly")}</span>
                <span className="run-time">
                  {Math.floor(s!.elapsedSeconds / 60)}{dt("min")}{" "}
                  {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} <b> / </b>{dt("budget")}{" "}
                  {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}
                </span>
              </div>
              <section className="metrics" aria-label={dt("roundSummary")}>
                <Metric
                  label={dt("metric.completed")}
                  value={String(s!.completed)}
                  detail={dt("metric.totalPrefix") + data.paging.totalCalls + dt("requestsUnit")}
                />
                {view === "live" ? (
                  <Metric
                    label={dt("metric.actions")}
                    value={String(s!.actions)}
                    detail={s!.explicitObserves + dt("metric.observes")}
                  />
                ) : (
                  <Metric
                    label={dt("metric.p95")}
                    value={seconds(s!.p95Ms)}
                    detail={dt("metric.nearestRank")}
                  />
                )}
                <Metric
                  label={dt("metric.median")}
                  value={seconds(s!.medianMs)}
                  detail={waitSummary || dt("metric.noWait")}
                />
                <Metric
                  label={dt("metric.cache")}
                  value={percent(s!.cacheHit)}
                  detail={dt("metric.afterFirst") + percent(s!.warmCacheHit)}
                />
              </section>
              {view === "live" ? (
                <div className="live-grid">
                  <div className="live-observation">
                    <ObservationPanel
                      data={data}
                      call={call}
                      selectedImage={selectedImage}
                      onImage={(id) => navigate({ ...pinned, image: id })}
                    />
                    <div className="run-context">
                      <button
                        className="text-button"
                        onClick={() => navigate({ view: "benchmark" })}
                      >
                        {dt("checkPerf")} ↗
                      </button>
                      {(query.has("call") || query.has("beforeCall")) && (
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate({ beforeCall: null, call: null, image: null, block: null })
                          }
                        >
                          {dt("backToLatest")} ↓
                        </button>
                      )}
                      <span>
                        {data.manifest.drivers.map((d) => d.id).join(" · ")}
                      </span>
                    </div>
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
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate({ beforeCall: null, call: null, image: null, block: null })
                          }
                        >
                          {dt("followLatest")} ↓
                        </button>
                      </div>
                      <p className="feed-notice">{pageRange}</p>
                      <div className="timeline-list">
                        {[...data.calls]
                          .reverse()
                          .map((c) => (
                            <button
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
                          <button className="text-button load-more"
                            onClick={() => navigate({ ...pinned, beforeCall: String(data.paging.beforeCall), call: null, image: null, block: null })}>
                            {dt("loadMore")}
                          </button>
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
