"use client";
import { useEffect, useRef, useState } from "react";
import type { Call, Observation, Project, RunData } from "@/lib/types";
import { sseFallbackReason } from "@/lib/transport";
import { initialSelection } from "@/lib/initial-selection";
const sec = (ms: number | null | undefined) =>
  ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
const mb = (n: number | null) =>
  n === null ? "—" : `${(n / 1e6).toFixed(2)} MB`;
const percent = (n: number | null) =>
  n == null ? "—" : `${(n * 100).toFixed(1)}%`;
const time = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
const date = (s: string) => {
  const p = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return p
    ? new Date(`${p[1]}T${p[2]}:${p[3]}:${p[4]}Z`).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : s;
};
const originName: Record<string, string> = {
  prompt_start: "轮次输入",
  tool_batch: "自动观测",
  explicit: "主动 observe",
  cli: "CLI 采样",
  unknown: "观测",
};
const requestBytes = (call: Call) =>
  call.transport === "websocket" ? call.frameBytes : call.wireBytes;
const transportName = (call: Call) =>
  call.transport === "websocket"
    ? `WS · ${call.incremental === null ? "未注明" : call.incremental ? "增量" : "全量"}`
    : call.transport === "sse" ? "SSE" : "传输未记录";
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "请求失败");
  return data;
}
function Chart({
  calls,
  type,
  selected,
  onSelect,
}: {
  calls: Call[];
  type: "latency" | "cache" | "body";
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const values = calls.map((c) => {
    const value = type === "latency" ? c.durationMs : type === "cache" ? c.cacheHit : requestBytes(c);
    return value === null ? null : value / (type === "latency" ? 1000 : type === "cache" ? 0.01 : 1e6);
  });
  const max = type === "cache" ? 100 : Math.max(1, ...values.flatMap(v => v === null ? [] : [v])) * 1.12;
  const x = (i: number) => 28 + ((i + 0.5) * 512) / Math.max(1, calls.length);
  const y = (v: number) => 113 - (v / max) * 88;
  const line = values
    .flatMap((v, i) =>
      v === null
        ? []
        : [`${x(i)},${y(v)}`],
    )
    .join(" ");
  return (
    <svg
      className="chart"
      viewBox="0 0 560 145"
      role="img"
      aria-label={
        type === "latency"
          ? "逐请求耗时和响应头等待"
          : type === "cache"
            ? "逐请求缓存命中率"
            : "逐请求体大小"
      }
    >
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line
            x1="28"
            x2="542"
            y1={y(v * max)}
            y2={y(v * max)}
            className="grid-line"
          />
          <text x="23" y={y(v * max) + 3} textAnchor="end">
            {(v * max).toFixed(0)}
          </text>
        </g>
      ))}
      {type === "latency" &&
        calls.map((c, i) => c.headersMs === null ? null : (
          <rect
            key={c.id}
            x={x(i) - Math.max(1, 170 / calls.length)}
            y={y(c.headersMs / 1000)}
            width={Math.max(2, 340 / calls.length)}
            height={Math.max(0, 113 - y(c.headersMs / 1000))}
            fill="#4c5c9d"
            opacity=".75"
          />
        ))}
      <polyline
        points={line}
        fill="none"
        stroke={
          type === "latency"
            ? "#a4b4ff"
            : type === "cache"
              ? "#7cdbb9"
              : "#e4ba73"
        }
        strokeWidth="2"
      />
      {calls.map((c, i) => (
        <g key={c.id}>
          {c.id === selected && (
            <line
              x1={x(i)}
              x2={x(i)}
              y1="19"
              y2="116"
              stroke="#fff"
              strokeDasharray="3 3"
              opacity=".45"
            />
          )}
          <rect
            x={x(i) - 256 / calls.length}
            y="12"
            width={512 / calls.length}
            height="112"
            fill="transparent"
            onClick={() => onSelect(c.id)}
            className="chart-hit"
          >
            <title>
              #{c.index} ·{" "}
              {values[i] === null
                ? "无数据"
                : `${values[i].toFixed(2)}${type === "latency" ? " 秒" : type === "cache" ? "%" : " MB"}`}
            </title>
          </rect>
        </g>
      ))}
      <text x="28" y="138">
        #1
      </text>
      <text x="542" y="138" textAnchor="end">
        #{calls.length || "—"}
      </text>
    </svg>
  );
}
export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [run, setRun] = useState("");
  const [epoch, setEpoch] = useState("");
  const [loaded, setData] = useState<RunData | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [panel, setPanel] = useState<"tools" | "skills" | "events">("tools");
  const initialCycle = useRef<{ project: string; run: string; epoch: string } | null>(null);
  useEffect(() => {
    let active = true;
    let initialized = false;
    const load = async () => {
      try {
        const ps = await json<Project[]>("/api/catalog");
        if (!active) return;
        setProjects(ps);
        if (!initialized && ps.length) {
          initialized = true;
          const target = initialSelection(window.location.search, ps);
          initialCycle.current = {
            ...target,
            run: target.run || ps.find((p) => p.id === target.project)?.runs[0]?.id || "",
          };
          setProject(target.project);
          setRun(target.run);
        } else {
          setProject((p) => p || ps[0]?.id || "");
        }
        setError("");
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void load();
    const id = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);
  const currentProject = projects.find((p) => p.id === project);
  const effectiveRun = run || currentProject?.runs[0]?.id || "";
  const data =
    loaded?.project === project &&
    loaded.run === effectiveRun &&
    (!epoch || loaded.selectedEpoch === epoch)
      ? loaded
      : null;
  const cycles =
    loaded?.project === project && loaded.run === effectiveRun
      ? loaded.cycles
      : [];
  const runUrl = `/api/run?project=${encodeURIComponent(project)}&run=${encodeURIComponent(effectiveRun)}${epoch ? `&epoch=${encodeURIComponent(epoch)}` : ""}`;
  useEffect(() => {
    if (!project || !effectiveRun) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setSelected(null);
    setImageId(null);
    const load = async () => {
      try {
        const next = await json<RunData>(runUrl);
        if (active) {
          const target = initialCycle.current;
          initialCycle.current = null;
          if (target?.project === next.project && target.run === next.run &&
              next.cycles.some((cycle) => cycle.epoch === target.epoch)) {
            setEpoch(target.epoch);
          }
          setData(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active && refresh) timer = setTimeout(load, 2500);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project, effectiveRun, epoch, refresh, runUrl]);
  const call = data?.calls.find((c) => c.id === selected) ?? data?.calls.at(-1);
  const fallbackReason = call && data
    ? sseFallbackReason(call, Date.parse(data.updatedAt))
    : null;
  const samples = call
    ? [...new Set([...call.inputObservations, ...call.observations])].flatMap(
        (id) => {
          const o = data?.observations.find((o) => o.id === id);
          return o ? [o] : [];
        },
      )
    : [];
  const observation =
    data?.observations.find((o) => o.id === imageId) ??
    samples.at(-1) ??
    data?.observations.at(-1);
  const mediaUrl = (o: Observation) =>
    `/api/media?project=${encodeURIComponent(project)}&run=${encodeURIComponent(effectiveRun)}&id=${encodeURIComponent(o.id)}`;
  const select = (id: string) => {
    setSelected(id);
    setImageId(null);
  };
  const live = data?.live;
  const selectedLive =
    live?.runId === data?.run && live?.connected &&
    data?.selectedEpoch !== null && data?.selectedEpoch === live?.epoch;
  const auto = selectedLive && live?.mode === "auto";
  const replayingCycle =
    data && data.selectedEpoch !== data.cycles.at(-1)?.epoch;
  const phase = auto ? data?.livePhase : null;
  const compacting = phase?.kind === "compaction";
  const s = data?.summary;
  const stop = async () => {
    if (!data || !live) return;
    setStopping(true);
    try {
      await json("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          run: effectiveRun,
          epoch: data.selectedEpoch,
          action: "off",
        }),
      });
      setData(await json(runUrl));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setStopping(false);
    }
  };
  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-symbol">
            r<span>↗</span>
          </span>
          <div>
            <strong>
              RSA <span>观察台</span>
            </strong>
            <small>RECURSIVE SELF-ADAPTATION</small>
          </div>
        </div>
        <div className="header-right">
          <span className="local-tag">LOCAL / 127.0.0.1</span>
          <button
            className={`refresh ${refresh ? "active" : ""}`}
            onClick={() => setRefresh(!refresh)}
          >
            <i />
            {refresh ? "实时刷新 · 2.5s" : "刷新已暂停"}
          </button>
        </div>
      </header>
      <section className="title-row">
        <div>
          <div className="eyebrow">ENVIRONMENT / SESSION / EVIDENCE</div>
          <h1>从画面，到行动。</h1>
          <p>观察每一轮决策，找到循环里的等待。</p>
        </div>
        <div className="selectors">
          <label>
            环境项目
            <select
              aria-label="环境项目"
              value={project}
              onChange={(e) => {
                initialCycle.current = null;
                setProject(e.target.value);
                setRun("");
                setEpoch("");
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            运行记录
            <select
              aria-label="运行记录"
              value={effectiveRun}
              onChange={(e) => {
                initialCycle.current = null;
                setRun(e.target.value);
                setEpoch("");
              }}
            >
              {currentProject?.runs.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {date(r.id)}
                  {i === 0 ? " · 最新" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            接管周期
            <select
              aria-label="接管周期"
              value={epoch}
              onChange={(e) => {
                initialCycle.current = null;
                setEpoch(e.target.value);
              }}
            >
              <option value="">
                跟随最新周期
                {cycles.length ? ` · #${cycles.length}` : " · 尚未接管"}
              </option>
              {[...cycles].reverse().map((cycle, i) => (
                <option key={cycle.epoch} value={cycle.epoch}>
                  #{cycles.length - i} · {time(cycle.startedAt)} ·{" "}
                  {cycle.epoch.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <div className="loading">
          <span className="loading-dot" />
          {projects.length ? "正在读取运行日志…" : "正在发现本地运行…"}
        </div>
      ) : (
        <>
          <section className="status-strip">
            <div className="status-main">
              <span className={`status-light ${auto ? "live" : ""}`} />
              <strong>
                {phase
                  ? phase.label
                  : auto
                    ? "AI 正在接管"
                    : replayingCycle
                      ? "周期回放"
                      : live
                        ? "控制权已交还"
                        : "运行回放"}
              </strong>
              <span className="dim">
                {phase
                  ? phase.startedAt
                    ? `已等待 ${sec(phase.elapsedMs)} · ${time(phase.startedAt)} 开始`
                    : "压缩事件交叠，起点不确定"
                  : data.controlReason}
              </span>
            </div>
            <div className="status-meta">
              <span>{data.manifest.model ?? "仅设备"}</span>
              <span>预算 {data.manifest.seconds}s</span>
              <span>
                压缩阈值 {data.manifest.compactionThreshold == null
                  ? "OMP 默认"
                  : `${data.manifest.compactionThreshold.toLocaleString("en-US")} tokens`}
              </span>
              <span>
                {Math.floor(s!.elapsedSeconds / 60)}分{" "}
                {Math.floor(s!.elapsedSeconds % 60)}秒
              </span>
              <button
                className="stop"
                disabled={!data.controlAllowed || !auto || stopping}
                onClick={stop}
              >
                {stopping ? "正在交还…" : "■ 交还控制权"}
              </button>
            </div>
          </section>
          <p className="scope-note">
            请求统计仅覆盖主循环；独立的 OMP
            压缩请求不计入下方请求数、耗时和缓存指标。
            WS 大小为构建的请求帧，不代表网络实收。
          </p>
          <section className="metrics">
            <Metric
              label="完成请求"
              value={String(s!.completed)}
              suffix={`/ ${data.calls.length}`}
              detail={`${data.calls.filter((c) => c.status === "pending").length} 个请求进行中`}
            />
            <Metric
              label="实际控制动作"
              value={String(s!.actions)}
              detail={`${s!.explicitObserves} 次独立 observe`}
            />
            <Metric
              label="请求耗时 · 中位数"
              value={sec(s!.medianMs)}
              detail={`响应头等待 ${sec(s!.medianHeadersMs)}`}
            />
            <Metric
              label="首请求后缓存命中"
              value={percent(s!.warmCacheHit)}
              detail={`全部请求 ${percent(s!.cacheHit)}`}
            />
            <Metric
              label="错误 / 自动压缩"
              value={`${s!.errors} / ${s!.compactions}`}
              detail="保留重试与中止证据"
            />
          </section>
          <section className="charts">
            <div className="chart-card">
              <div className="section-label">
                请求延迟 <span>秒</span>
                <div className="legend">
                  <i />
                  总耗时 <i className="wait" />
                  HTTP 响应头等待
                </div>
              </div>
              <Chart
                calls={data.calls}
                type="latency"
                selected={call?.id}
                onSelect={select}
              />
            </div>
            <div className="chart-card">
              <div className="section-label">
                缓存命中 <span>%</span>
              </div>
              <Chart
                calls={data.calls}
                type="cache"
                selected={call?.id}
                onSelect={select}
              />
            </div>
            <div className="chart-card">
              <div className="section-label">
                请求体大小 <span>MB · HTTP body / 构建的 WS 帧</span>
              </div>
              <Chart
                calls={data.calls}
                type="body"
                selected={call?.id}
                onSelect={select}
              />
            </div>
          </section>
          <section className="workbench">
            <aside className="timeline">
              <div className="pane-heading">
                <h2>请求时间轴</h2>
                <button
                  className={!selected ? "follow selected" : "follow"}
                  onClick={() => {
                    setSelected(null);
                    setImageId(null);
                  }}
                >
                  跟随最新 ↓
                </button>
              </div>
              <div className="timeline-list">
                {[...data.calls].reverse().map((c) => (
                  <button
                    key={c.id}
                    className={`request ${c.id === call?.id ? "selected" : ""}`}
                    onClick={() => select(c.id)}
                  >
                    <div className="request-head">
                      <span className="request-number">
                        #{String(c.index).padStart(3, "0")}
                      </span>
                      <time>{time(c.at)}</time>
                      <span className={`request-state ${c.status}`}>
                        {c.status === "pending"
                          ? "思考中"
                          : c.status === "aborted"
                            ? "中止"
                            : c.status === "error"
                              ? "失败"
                              : sec(c.durationMs)}
                      </span>
                    </div>
                    <div className="request-intent">
                      {c.tools[0]?.intent ||
                        c.tools.map((t) => t.name).join(" · ") ||
                        (c.status === "pending" ? "等待模型响应…" : "文本回复")}
                    </div>
                    <div className="request-bottom">
                      <span>
                        {transportName(c)} · {c.tools.map((t) => t.name).join(" + ") || "response"}
                      </span>
                      <span>
                        {mb(requestBytes(c))} <b>·</b> {percent(c.cacheHit)}
                      </span>
                    </div>
                    <div className="request-meter">
                      <i
                        style={{
                          width: `${Math.min(100, ((c.headersMs ?? 0) / Math.max(1, c.durationMs ?? 1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </button>
                ))}
                {data.calls.length === 0 && (
                  <div className="empty">
                    {compacting
                      ? "OMP 正在压缩历史"
                      : !data.selectedEpoch
                        ? "尚未开启接管周期。"
                        : "本周期尚无模型请求。"}
                    <br />
                    {compacting
                      ? phase!.startedAt
                        ? `已等待 ${sec(phase!.elapsedMs)}，完成后开始主循环。`
                        : "压缩事件交叠，等待结束事件。"
                      : !data.selectedEpoch
                        ? "开启后将显示该周期的观测与请求。"
                        : "等待本周期的主循环请求。"}
                  </div>
                )}
              </div>
            </aside>
            <div className="inspection">
              <div className="pane-heading">
                <h2>
                  {call
                    ? `请求 #${String(call.index).padStart(3, "0")}`
                    : "传感器画面"}{" "}
                  <span>
                    {observation
                      ? (originName[observation.origin] ?? observation.origin)
                      : ""}
                  </span>
                </h2>
                <span className="dim mono">
                  {observation ? time(observation.at) : "等待观测"}
                </span>
              </div>
              <div className="screen">
                {observation ? (
                  observation.mediaType.startsWith("image/") ? (
                    <img
                      src={mediaUrl(observation)}
                      alt={`传感器 ${observation.sensor} 在 ${time(observation.at)} 保存的观测`}
                    />
                  ) : (
                    <audio controls src={mediaUrl(observation)} />
                  )
                ) : (
                  <div className="empty">暂无可展示画面</div>
                )}
                <div className="screen-caption">
                  <span>
                    {observation?.sensor ?? "sensor"} /{" "}
                    {observation?.id.slice(0, 8) ?? "—"}
                  </span>
                  {observation?.afterExecutionMs !== undefined && (
                    <span>
                      动作结束 → 采样请求{" "}
                      {observation.afterExecutionMs.toFixed(1)} ms
                    </span>
                  )}
                </div>
              </div>
              <div className="sample-row">
                {samples.map((o) => (
                  <button
                    className={
                      o.id === observation?.id ? "sample selected" : "sample"
                    }
                    key={o.id}
                    onClick={() => setImageId(o.id)}
                  >
                    {o.mediaType.startsWith("image/") && (
                      <img src={mediaUrl(o)} alt="观测缩略图" />
                    )}
                    <div>
                      <strong>
                        {call?.inputObservations.includes(o.id)
                          ? "输入画面"
                          : "工具后画面"}
                      </strong>
                      <span>
                        {originName[o.origin] ?? o.origin} · {time(o.at)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {fallbackReason && (
                <p className="transport-note">
                  <strong>SSE 回退</strong> · {fallbackReason}
                </p>
              )}
              {call && (
                <div className="call-stats">
                  <div>
                    <small>模型总耗时</small>
                    <b>{sec(call.durationMs)}</b>
                  </div>
                  <div>
                    <small>{call.transport === "websocket" ? "WS 首事件等待" : "HTTP 响应头前等待"}</small>
                    <b>{sec(call.transport === "websocket" ? call.phases.afterDispatchMs : call.headersMs)}</b>
                  </div>
                  <div>
                    <small>{call.transport === "websocket" ? "首事件后完成" : "响应头后完成"}</small>
                    <b>{sec(call.transport === "websocket" ? call.phases.afterFirstStreamMs : call.phases.afterHeadersMs)}</b>
                  </div>
                  <div>
                    <small>输入 tokens</small>
                    <b>
                      {call.inputTokens
                        ? call.inputTokens.toLocaleString()
                        : "—"}
                    </b>
                  </div>
                  <div>
                    <small>{call.transport === "websocket" ? "构建的 WS 帧" : "HTTP 尝试"}</small>
                    <b>{(call.transport === "websocket" ? call.wsFrames : call.attempts) || "—"}</b>
                  </div>
                </div>
              )}
              <div className="detail-tabs">
                <button
                  className={panel === "tools" ? "active" : ""}
                  onClick={() => setPanel("tools")}
                >
                  动作与观测 <span>{call?.tools.length ?? 0}</span>
                </button>
                <button
                  className={panel === "skills" ? "active" : ""}
                  onClick={() => setPanel("skills")}
                >
                  技能证据 <span>{data.skills.length}</span>
                </button>
                <button
                  className={panel === "events" ? "active" : ""}
                  onClick={() => setPanel("events")}
                >
                  错误与压缩 <span>{data.notices.length}</span>
                </button>
              </div>
              <div className="details">
                {panel === "tools" ? (
                  <>
                    {call?.tools.map((t) => (
                      <article className="tool" key={t.id}>
                        <div className="tool-title">
                          <strong>{t.name}</strong>
                          <span>{t.intent}</span>
                          <em className={t.ok === false ? "failed" : ""}>
                            {t.ok === null ? "执行中" : t.ok ? "完成" : "错误"}
                          </em>
                        </div>
                        <pre>
                          {t.args.command ?? JSON.stringify(t.args, null, 2)}
                        </pre>
                        <div className="observation-details">
                          {t.name === "exec" && (
                            <span>命令执行 {sec(t.commandMs)}</span>
                          )}
                          <span>工具全程（含后续观测）{sec(t.durationMs)}</span>
                        </div>
                        {t.name === "exec" && (
                          <p className="note">
                            命令执行已包含在工具全程内，两者不相加。
                          </p>
                        )}
                      </article>
                    ))}
                    {call?.tools.length === 0 && (
                      <p className="dim">本轮没有工具调用。</p>
                    )}
                    {observation && (
                      <>
                        <div className="observation-details">
                          <span>观测耗时（含请求延迟）{sec(observation.captureMs)}</span>
                          <span>编码 {sec(observation.encodeMs)}</span>
                          <span>源帧 {observation.sourceSequence ?? "—"}</span>
                          <span>
                            帧增量 {observation.sourceSequenceDelta ?? "—"}
                          </span>
                        </div>
                        {observation.request && (
                          <>
                            <p className="note">原始观测请求</p>
                            <pre aria-label="原始观测请求">
                              {JSON.stringify(observation.request, null, 2)}
                            </pre>
                          </>
                        )}
                      </>
                    )}
                    <p className="note">
                      响应头前等待包含传输与服务端处理，不能据此单独归因于上传或排队。
                    </p>
                  </>
                ) : panel === "skills" ? (
                  <>
                    {[...data.skills].reverse().map((e) => (
                      <button
                        className="evidence"
                        key={e.seq}
                        onClick={() => e.modelCallId && select(e.modelCallId)}
                      >
                        <span className="badge">{e.action}</span>
                        <div>
                          <strong>{e.path}</strong>
                          <small>
                            {time(e.at)} ·{" "}
                            {e.ok === null ? "执行中" : e.ok ? "成功" : "失败"}
                            {e.hash ? ` · ${e.hash.slice(0, 12)}` : ""}
                          </small>
                        </div>
                        <span>↗</span>
                      </button>
                    ))}
                    {!data.skills.length && (
                      <p className="dim">本次运行还没有技能读取或更新证据。</p>
                    )}
                  </>
                ) : (
                  <>
                    {[...data.notices].reverse().map((n) => (
                      <button
                        className="evidence"
                        key={n.seq}
                        onClick={() => n.modelCallId && select(n.modelCallId)}
                      >
                        <span
                          className={n.failed ? "event-dot error" : "event-dot"}
                        />
                        <div>
                          <strong>{n.type}</strong>
                          <p>{n.text}</p>
                          {n.details && n.details.length > 0 && (
                            <dl className="event-details">
                              {n.details.map((detail) => (
                                <div key={detail.label}>
                                  <dt>{detail.label}</dt>
                                  <dd>{detail.value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                          <small>{time(n.at)}</small>
                        </div>
                      </button>
                    ))}
                    {!data.notices.length && (
                      <p className="dim">本次运行没有错误或压缩事件。</p>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>
          <footer>
            <span>
              RSA OBSERVATORY <b>/</b> 仅使用本地事件与观测
            </span>
            <span>更新于 {time(data.updatedAt)} · Asia/Shanghai</span>
          </footer>
        </>
      )}
    </main>
  );
}
function Metric({
  label,
  value,
  suffix,
  detail,
}: {
  label: string;
  value: string;
  suffix?: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <div>
        {value}
        <small>{suffix}</small>
      </div>
      <p>{detail}</p>
    </div>
  );
}
