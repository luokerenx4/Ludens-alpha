"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Project, RunData } from "@/lib/types";
import type { ReplayOverviewResult } from "@/lib/replay-types";
import { initialSelection, latestGameRun } from "@/lib/initial-selection";
import { ActivityFeed } from "@/components/activity-feed";
import { useActivityFeed } from "@/components/use-activity-feed";
import { PerceptionSettingsPanel } from "@/components/perception-settings";
import { PetSettings } from "@/components/pet-settings";
import { PetFollowCard, usePetFollow } from "@/components/pet-follow";
import { DesktopBridge } from "@/components/desktop-bridge";
import { BenchmarkCases } from "@/components/benchmark-cases";
import { DocsView } from "@/components/docs-view";
import { CapabilitiesView } from "@/components/capabilities-view";
import { TimelinePlayer } from "@/components/timeline-player";
import { ArchiveBuild } from "@/components/archive-build";
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
const views = {
  live: ["运行", "运行现场", "实时观察模型输入画面、活动日志与控制状态。"],
  replay: ["回放", "经历回放", "在同一条时间轴上对齐感知画面、设备动作与模型调用。"],
  benchmark: ["Benchmark", "运行性能", "追踪单次请求的传输等待、缓存命中与显式调用链。"],
  caps: ["能力", "能力与评测", "查看当前工作区的设备接口快照、Python @capability 与评测任务。"],
  perception: ["感知", "感知录制设置", "调整当前工作区的录像分段与内存加速窗口。"],
  pet: ["Ludens Pet", "Ludens Pet 陪伴", "配置桌宠关注的工作区、气泡通知与声音偏好。"],
  docs: ["文档", "项目文档", "教程、架构契约与设计洞见（从仓库 docs/ 实时读取）。"],
} as const;
type View = keyof typeof views;
function workspaceName(project?: Project) {
  if (!project) return "选择工作区";
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
      ) : kind === "docs" ? (
        <>
          <path d="M5 3h11l3 3v15H5Z" /><path d="M9 9h7M9 13h7M9 17h4" />
        </>
      ) : kind === "caps" ? (
        <>
          <path d="M9 3H5v18h14V3h-4" /><path d="M9 3h6v4H9Z" /><path d="m9 16 2 2 4-4" />
        </>
      ) : kind === "benchmark" ? (
        <>
          <path d="M4 19V11M10 19V5M16 19V8M22 19V2" strokeWidth="3" />
        </>
      ) : (
        <>
          <path d="M4 18v-6a8 8 0 0 1 16 0v6M7 21h10M8 13h.01M16 13h.01M9 17q3 3 6 0" />
          <path d="M2 12v5h3M22 12v5h-3" />
        </>
      )}
    </svg>
  );
}

export default function Dashboard() {
  const search = useSyncExternalStore(
    subscribeLocation,
    getLocation,
    serverLocation,
  );
  const query = new URLSearchParams(search);
  const view: View =
    query.get("view") === "replay" ? "replay" : query.get("view") === "benchmark"
      ? "benchmark"
      : query.get("view") === "docs"
        ? "docs"
        : query.get("view") === "caps"
          ? "caps"
          : query.get("view") === "pet"
            ? "pet"
            : query.get("view") === "perception"
              ? "perception"
              : "live";
  const benchmarkCases = view === "benchmark" && query.get("bench") === "cases";
  const includeEmptyProjects = view === "caps" || view === "perception";
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
  }, [includeEmptyProjects]);
  useEffect(() => {
    if (benchmarkCases || view === "replay" || view === "docs" || view === "caps" || view === "perception" || !selection.project || !run) return;
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
      ? "AI 正在接管"
      : data
        ? returned || (isCurrent && live?.connected)
          ? "控制权已交还"
          : "历史运行回放"
        : "等待运行");
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
      if (!response.ok) throw new Error(result.error ?? "交还失败");
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
    s?.medianHttpHeadersMs != null ? "HTTP 响应头等待 " + seconds(s.medianHttpHeadersMs) : "",
    s?.medianWsWaitMs != null ? "WS 首事件等待 " + seconds(s.medianWsWaitMs) : "",
  ].filter(Boolean).join(" · ");
  const pageRange = data?.calls.length ? `本页 #${data.paging.firstIndex}–#${data.paging.lastIndex} · 共 ${data.paging.totalCalls} 个请求` : "本页无请求";
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
            {benchmarkCases ? "评测目录 · 跨工作区" : view === "docs" ? "文档来源" : view === "pet" ? "伴侣设置" : "工作区"}
          </label>
          {benchmarkCases ? (
            <div className="bench-global-workspace">所有工作区</div>
          ) : view === "docs" ? (
            <div className="bench-global-workspace">仓库 docs/</div>
          ) : view === "pet" ? (
            <div className="bench-global-workspace">桌面与网页共享</div>
          ) : (
            <select
              id="workspace"
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
              {!projects.length && <option value="">暂无工作区</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {workspaceName(p)}
                </option>
              ))}
            </select>
          )}
        </div>
        <nav aria-label="控制台导航">
          {(Object.keys(views) as View[]).map((id) => (
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
              <span>{views[id][0]}</span>
            </a>
          ))}
        </nav>
        <PetFollowCard follow={pet} project={benchmarkCases || view === "docs" || view === "pet" ? undefined : project}
          onSettings={() => navigate({ view: "pet" })} />
      </aside>
      <div className="console-main">
        <header className="context-bar">
          <div className="breadcrumb">
            <span>
              {benchmarkCases ? "所有工作区" : view === "docs" || view === "pet" ? "Ludens" : workspaceName(project)}
            </span>
            <i>/</i>
            <strong>{views[view][0]}</strong>
          </div>
          <div className="context-controls">
            {!benchmarkCases && view !== "docs" && view !== "caps" && view !== "perception" && view !== "pet" && (
              <>
                <select
                  aria-label="运行记录"
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
                  <option value="">
                    最新运行
                    {latest
                      ? " · " + runDate(latest.id)
                      : ""}
                  </option>
                  {project?.runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runDate(r.id)}
                      {r.kind === "benchmark" ? " · 评测" : ""}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="接管周期"
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
                  <option value="">
                    {data?.manifest.kind === "benchmark" && !cycles.length
                      ? "完整基准运行"
                      : "最新周期"}
                    {cycles.length ? " · #" + cycles.length : ""}
                  </option>
                  {view === "replay" && <option value="all">全部周期</option>}
                  {[...cycles].reverse().map((c, i) => (
                    <option key={c.epoch} value={c.epoch}>
                      #{cycles.length - i} · {clockTime(c.startedAt)}
                    </option>
                  ))}
                </select>
              </>
            )}
            {view !== "replay" && view !== "docs" && view !== "caps" && view !== "perception" && view !== "pet" && <button
              className={"refresh-toggle" + (refresh ? " active" : "")}
              aria-pressed={refresh}
              title="只控制界面刷新，不影响 Agent"
              onClick={() => setRefresh((v) => !v)}
            >
              <i className="status-dot" />
              {refresh ? "实时" : "已暂停刷新"}
            </button>}
          </div>
        </header>
        <main className="page-content">
          <div className="page-heading">
            <div>
              <h1>{benchmarkCases ? "评测目录" : views[view][1]}</h1>
              <p>
                {benchmarkCases ? "重复评测能力，查看指标、条件与原始证据。" : views[view][2]}
              </p>
            </div>
            {view !== "pet" && view !== "replay" && view !== "docs" && view !== "caps" && view !== "perception" && !benchmarkCases && (
              <button
                className="control-button handback"
                disabled={!data?.controlAllowed || !auto || stopping}
                title={data?.controlReason ?? "暂无运行"}
                onClick={stop}
              >
                {stopping ? "正在交还…" : "交还控制权"}
              </button>
            )}
          </div>
          {view === "benchmark" && (
            <nav className="benchmark-tabs" aria-label="Benchmark 视图">
              {[
                ["analysis", "运行剖析"],
                ["cases", "评测目录"],
              ].map(([tab, title]) => (
                <button
                  key={tab}
                  aria-pressed={benchmarkCases === (tab === "cases")}
                  className={
                    benchmarkCases === (tab === "cases") ? "active" : ""
                  }
                  onClick={() =>
                    navigate({ bench: tab === "cases" ? "cases" : null })
                  }
                >
                  {title}
                </button>
              ))}
            </nav>
          )}
          {!benchmarkCases && view !== "pet" && view !== "docs" && view !== "caps" && view !== "perception" && <ArchiveBuild key={selection.project + "/" + run}
            project={selection.project} run={run} onReady={archiveReady} />}
          {!benchmarkCases && view !== "docs" && view !== "caps" && view !== "perception" && (catalogError || (view !== "replay" && error)) && (
            <div className="error-banner" role="alert">
              {catalogError || error}
              {data && (
                <small>保留上次读取结果 · {clockTime(data.updatedAt)}</small>
              )}
            </div>
          )}
          {view === "pet" ? (
            <PetSettings follow={pet} projects={projects} />
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
                  ? "正在发现工作区"
                  : !projects.length
                    ? "还没有运行记录"
                    : error
                      ? "暂时无法读取运行"
                      : preparing?.key === key ? "正在整理历史目录" : "正在读取运行日志"}
              </h2>
              <p>
                {!catalogReady
                  ? "正在连接本地日志服务…"
                  : !projects.length
                    ? "在工作区启动 RSA 后，实时画面、活动日志与性能统计会显示在这里。"
                    : error
                      ? "请检查本地日志服务，恢复连接后会自动更新。"
                      : preparing?.key === key
                        ? `已读取 ${bytes(preparing.progress.bytes)} / ${bytes(preparing.progress.totalBytes)}${preparing.progress.projection ? `，已整理 ${preparing.progress.projection.position.toLocaleString()} / ${preparing.progress.projection.total.toLocaleString()} 条已知事件` : ""}。录像可在回放页直接播放。`
                        : "正在加载当前工作区的观察与行动记录…"}
              </p>
            </section>
          ) : (
            <>
              <div className="run-status">
                <span className={"status-dot " + (auto ? "online" : "")} />
                <strong>{status}</strong>
                {phase?.elapsedMs != null && (
                  <span>已持续 {seconds(phase.elapsedMs)}</span>
                )}
                <i />
                <span>{data.manifest.model ?? "仅设备"}</span>
                <span className="run-time">
                  {Math.floor(s!.elapsedSeconds / 60)}分{" "}
                  {Math.floor(s!.elapsedSeconds % 60)}秒 <b> / </b>预算{" "}
                  {Math.floor(data.manifest.seconds / 60)}分钟
                </span>
              </div>
              <section className="metrics" aria-label="本轮概况">
                <Metric
                  label="完成请求"
                  value={String(s!.completed)}
                  detail={"共 " + data.paging.totalCalls + " 个请求"}
                />
                {view === "live" ? (
                  <Metric
                    label="控制动作"
                    value={String(s!.actions)}
                    detail={s!.explicitObserves + " 次主动观测"}
                  />
                ) : (
                  <Metric
                    label="P95 延迟"
                    value={seconds(s!.p95Ms)}
                    detail="完成请求 · nearest-rank"
                  />
                )}
                <Metric
                  label="请求中位数"
                  value={seconds(s!.medianMs)}
                  detail={waitSummary || "传输等待未记录"}
                />
                <Metric
                  label="缓存命中"
                  value={percent(s!.cacheHit)}
                  detail={"首请求后 " + percent(s!.warmCacheHit)}
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
                        检查本轮性能 ↗
                      </button>
                      {(query.has("call") || query.has("beforeCall")) && (
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate({ beforeCall: null, call: null, image: null, block: null })
                          }
                        >
                          回到最新请求 ↓
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
                              ? "请求耗时"
                              : type === "cache"
                                ? "缓存命中"
                                : "请求体大小"}
                          </h2>
                          <span>
                            {type === "latency"
                              ? "灰柱：HTTP 响应头 / WS 首事件 · 秒"
                              : type === "cache"
                                ? "%"
                                : "MB · HTTP / WS 构建帧"}
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
                        <h2>请求时间轴</h2>
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate({ beforeCall: null, call: null, image: null, block: null })
                          }
                        >
                          跟随最新 ↓
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
                                    ? "进行中"
                                    : c.status === "error"
                                      ? "失败"
                                      : c.status === "aborted"
                                        ? "已中止"
                                        : seconds(c.durationMs)}
                                </span>
                              </div>
                              <p>
                                {c.tools[0]?.intent ||
                                  c.tools.map((t) => t.name).join(" · ") ||
                                  (c.status === "pending"
                                    ? "等待模型响应"
                                    : "文本回复")}
                              </p>
                              <small>
                                {clockTime(c.at)} <span>{transport(c)}</span>
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
                            上一页 · 更早的 100 个请求
                          </button>
                        )}
                        {!data.calls.length && (
                          <div className="empty-state">
                            <p>
                              {data.activeCompaction
                                ? "正在压缩历史，等待主循环请求。"
                                : data.selectedEpoch
                                  ? "本周期尚无模型请求。"
                                  : data.manifest.benchmark
                                    ? "此基准没有主循环模型请求。"
                                    : "尚未开启接管周期。"}
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
                      <h2>运行事件来源</h2>
                      <p>按职责追踪同一次执行。</p>
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
                        原生循环{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.shiori.nativeLoops.length
                            : "—"}
                        </b>
                      </span>
                      <span>
                        能力调用{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.capabilities.stats.started
                            : "—"}
                        </b>
                      </span>
                      <span>
                        设备操作{" "}
                        <b>
                          {hasTelemetry ? data.telemetry.devices.started : "—"}
                        </b>
                      </span>
                      <span>
                        错误事件 <b>{s!.errors}</b>
                      </span>
                      <span>
                        自动压缩 <b>{s!.compactions}</b>
                      </span>
                    </div>
                  </section>
                  <details className="run-provenance">
                    <summary>运行配置与指标口径</summary>
                    <dl className="fact-grid">
                      <div>
                        <dt>Shiori</dt>
                        <dd>
                          {data.manifest.shiori?.implementation ?? "未记录"}{" "}
                          {data.manifest.shiori?.implementationVersion}
                        </dd>
                      </div>
                      <div>
                        <dt>压缩阈值</dt>
                        <dd>
                          {data.manifest.compactionThreshold?.toLocaleString() ??
                            "默认"}
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
                              ? "完整运行 · 无接管周期"
                              : "尚未接管")}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      主循环请求统计不含后台独立压缩请求；Shiori、工具与嵌套能力的耗时呈包含关系，不重复累加。HTTP 等待计至响应头，WS 等待计至首个入站事件（请求体为构建帧大小）。图表与时间轴按请求分页（{pageRange}），完整历史可在运行页的活动日志中检索。
                    </p>
                  </details>
                </>
              )}
              <footer className="page-footer">
                <span>
                  ⓘ{" "}
                  {view === "live"
                    ? "日志记录执行事实，任务进展以画面为准。"
                    : "包含关系的耗时不相加 · 模型统计不含独立压缩请求"}
                </span>
                <span>更新于 {clockTime(data.updatedAt)}</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
