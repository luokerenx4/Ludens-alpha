"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Project, RunData } from "@/lib/types";
import type { LogBlock } from "@/lib/activity";
import { initialSelection, latestGameRun } from "@/lib/initial-selection";
import { medianRequestWaits } from "@/lib/transport";
import { ActivityFeed } from "@/components/activity-feed";
import { AliceSettings } from "@/components/alice-settings";
import { AliceFollowCard, useAliceFollow } from "@/components/alice-follow";
import { DesktopBridge } from "@/components/desktop-bridge";
import { BenchmarkCases } from "@/components/benchmark-cases";
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

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "读取失败");
  return result;
}
const subscribeLocation = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const getLocation = () => window.location.search;
const serverLocation = () => "";
const views = {
  live: ["运行", "运行现场", "看看它正在看什么、做什么。"],
  benchmark: ["Benchmark", "运行性能", "沿着一次请求，找到循环里的等待。"],
  alice: ["Alice", "与 Alice 一起工作", "按自己的习惯，调整她的陪伴方式。"],
} as const;
type View = keyof typeof views;
function workspaceName(project?: Project) {
  if (!project) return "选择工作空间";
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
    query.get("view") === "benchmark"
      ? "benchmark"
      : query.get("view") === "alice"
        ? "alice"
        : "live";
  const benchmarkCases = view === "benchmark" && query.get("bench") === "cases";
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; data: RunData } | null>(
    null,
  );
  const [activity, setActivity] = useState<{
    key: string;
    epoch: string | null;
    blocks: LogBlock[];
  } | null>(null);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [refresh, setRefresh] = useState(true);
  const alice = useAliceFollow();
  const [stopping, setStopping] = useState(false);
  const [panel, setPanel] = useState("trace");
  const [requestLimit, setRequestLimit] = useState(100);
  const selection = initialSelection(search, projects);
  const project = projects.find((p) => p.id === selection.project);
  const latest = latestGameRun(project);
  const run = selection.run || latest?.id || "";
  const key = selection.project + "/" + run + "/" + selection.epoch;
  const data = loaded?.key === key ? loaded.data : null;
  const blocks =
    activity?.key === key && activity.epoch === data?.selectedEpoch
      ? activity.blocks
      : [];
  const call =
    data?.calls.find((c) => c.id === query.get("call")) ?? data?.calls.at(-1);
  const selectedImage = query.get("image") ?? undefined;
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
        const value = await json<Project[]>("/api/catalog", controller.signal);
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
  }, []);
  useEffect(() => {
    if (benchmarkCases || !selection.project || !run) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({
      project: selection.project,
      run,
      ...(selection.epoch ? { epoch: selection.epoch } : {}),
    });
    const load = async () => {
      try {
        const next = await json<RunData>(
          "/api/run?" + params,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setLoaded({ key, data: next });
        setError("");
        if (view === "live") {
          try {
            // Pin activity to the cycle returned by /run so a new takeover cannot mix two cycles.
            const activityParams = new URLSearchParams(params);
            if (next.selectedEpoch)
              activityParams.set("epoch", next.selectedEpoch);
            const result = await json<{ blocks: LogBlock[] }>(
              "/api/activity?" + activityParams,
              controller.signal,
            );
            if (!controller.signal.aborted) {
              setActivity({
                key,
                epoch: next.selectedEpoch,
                blocks: result.blocks,
              });
              setActivityError("");
            }
          } catch (e) {
            if (!controller.signal.aborted) setActivityError(String(e));
          }
        }
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
    key,
    refresh,
    view,
    benchmarkCases,
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
  const waitSummary = medianRequestWaits(data?.calls ?? [])
    .map((wait) => wait.label + " " + seconds(wait.ms))
    .join(" · ");
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
          <span>Playness</span>
        </a>
        <div className="workspace-picker">
          <label htmlFor="workspace">
            {benchmarkCases ? "评测目录 · 跨工作空间" : "工作空间"}
          </label>
          {benchmarkCases ? (
            <div className="bench-global-workspace">所有工作空间</div>
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
                  call: null,
                  block: null,
                  image: null,
                })
              }
            >
              {!projects.length && <option value="">暂无工作空间</option>}
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
              href={
                "?" +
                new URLSearchParams({ ...Object.fromEntries(query), view: id })
              }
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate({ view: id });
              }}
            >
              <NavIcon kind={id} />
              <span>{views[id][0]}</span>
            </a>
          ))}
        </nav>
        <AliceFollowCard follow={alice} project={benchmarkCases ? undefined : project}
          onSettings={() => navigate({ view: "alice" })} />
      </aside>
      <div className="console-main">
        <header className="context-bar">
          <div className="breadcrumb">
            <span>
              {benchmarkCases ? "所有工作空间" : workspaceName(project)}
            </span>
            <i>/</i>
            <strong>{views[view][0]}</strong>
          </div>
          <div className="context-controls">
            {!benchmarkCases && (
              <>
                <select
                  aria-label="运行记录"
                  value={selection.run}
                  onChange={(e) =>
                    navigate({
                      run: e.target.value,
                      epoch: null,
                      call: null,
                      block: null,
                      image: null,
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
                      call: null,
                      block: null,
                      image: null,
                    })
                  }
                >
                  <option value="">
                    {data?.manifest.kind === "benchmark" && !data.cycles.length
                      ? "完整基准运行"
                      : "最新周期"}
                    {data?.cycles.length ? " · #" + data.cycles.length : ""}
                  </option>
                  {[...(data?.cycles ?? [])].reverse().map((c, i) => (
                    <option key={c.epoch} value={c.epoch}>
                      #{data!.cycles.length - i} · {clockTime(c.startedAt)}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              className={"refresh-toggle" + (refresh ? " active" : "")}
              aria-pressed={refresh}
              title="只控制界面刷新，不影响 Agent"
              onClick={() => setRefresh((v) => !v)}
            >
              <i className="status-dot" />
              {refresh ? "实时" : "已暂停刷新"}
            </button>
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
            {view !== "alice" && !benchmarkCases && (
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
          {!benchmarkCases && (catalogError || error) && (
            <div className="error-banner" role="alert">
              {catalogError || error}
              {data && (
                <small>保留上次读取结果 · {clockTime(data.updatedAt)}</small>
              )}
            </div>
          )}
          {view === "alice" ? (
            <AliceSettings follow={alice} projects={projects} />
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
                  ? "正在发现工作空间"
                  : !projects.length
                    ? "还没有运行记录"
                    : error
                      ? "暂时无法读取运行"
                      : "正在读取运行日志"}
              </h2>
              <p>
                {!catalogReady
                  ? "连接本地日志服务…"
                  : !projects.length
                    ? "在工作空间启动 RSA 后，画面、日志和性能会出现在这里。"
                    : error
                      ? "请检查本地日志服务，恢复连接后会自动更新。"
                      : "保留每一次观察与行动。"}
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
                  detail={"共 " + data.calls.length + " 个请求"}
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
                      {query.has("call") && (
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate({ call: null, image: null, block: null })
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
                    key={key + "/" + data.selectedEpoch}
                    blocks={blocks}
                    selectedBlock={query.get("block") ?? undefined}
                    loading={
                      activity?.key !== key ||
                      activity.epoch !== data.selectedEpoch
                    }
                    error={activityError}
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
                            navigate({ call: null, image: null, block: null })
                          }
                        >
                          跟随最新 ↓
                        </button>
                      </div>
                      <div className="timeline-list">
                        {data.calls
                          .slice(-requestLimit)
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
                        {data.calls.length > requestLimit && (
                          <button
                            className="text-button load-more"
                            onClick={() => setRequestLimit((n) => n + 100)}
                          >
                            显示更早的 100 个请求
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
                      请求统计仅含主循环，独立压缩请求单列于事件。Shiori、工具和嵌套能力的耗时与用量不能相加。WS
                      字节是构建帧大小；HTTP 等待截至响应头，WS
                      等待从发送截至首事件，概况分别取完成请求的中位数。两者都不能进一步拆分网络与服务端耗时。来源分布仅覆盖当前运行事件，不代表
                      Pet 的在线状态。
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
