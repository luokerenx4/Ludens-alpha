"use client";
import type { Call, Observation, RunData, TraceSpan } from "@/lib/types";
import { requestWait, sseFallbackReason } from "@/lib/transport";

export const seconds = (ms: number | null | undefined) =>
  ms == null ? "—" : (ms / 1000).toFixed(1) + " s";
export const percent = (n: number | null | undefined) =>
  n == null ? "—" : (n * 100).toFixed(1) + "%";
export const bytes = (n: number | null | undefined) =>
  n == null ? "—" : (n / 1e6).toFixed(2) + " MB";
export const clockTime = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
export const requestBytes = (c: Call) =>
  c.transport === "websocket" ? c.frameBytes : c.wireBytes;
export const transport = (c: Call) =>
  c.transport === "websocket"
    ? "WS · " +
      (c.incremental == null ? "未注明" : c.incremental ? "增量" : "全量")
    : c.transport === "sse"
      ? "SSE"
      : "未记录传输";
const outcomeLabel: Record<string, string> = {
  success: "完成",
  error: "失败",
  cancelled: "已取消",
  pending: "进行中",
  unknown: "未知",
};
export const observationOrigin: Record<string, string> = {
  prompt_start: "轮次输入",
  tool_batch: "自动观测",
  explicit: "主动观测",
  cli: "CLI 采样",
};

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function RequestChart({
  calls,
  type,
  selected,
  onSelect,
}: {
  calls: Call[];
  type: "latency" | "cache" | "body";
  selected?: string;
  onSelect(id: string): void;
}) {
  const waits = calls.map(requestWait);
  const values = calls.map((c) =>
    type === "latency"
      ? c.durationMs == null
        ? null
        : c.durationMs / 1000
      : type === "cache"
        ? c.cacheHit == null
          ? null
          : c.cacheHit * 100
        : requestBytes(c) == null
          ? null
          : requestBytes(c)! / 1e6,
  );
  const maximum =
    type === "cache"
      ? 100
      : Math.max(
          1,
          ...values.filter((v): v is number => v !== null),
          ...(type === "latency"
            ? waits.flatMap((wait) =>
                wait.ms === null ? [] : [wait.ms / 1000],
              )
            : []),
        ) * 1.15;
  const x = (i: number) => 38 + ((i + 0.5) * 310) / Math.max(1, calls.length);
  const y = (v: number) => 133 - (v / maximum) * 108;
  const color =
    type === "latency"
      ? "var(--gold)"
      : type === "cache"
        ? "var(--sage)"
        : "var(--blue)";
  const segments: string[] = [];
  let path = "";
  values.forEach((value, i) => {
    if (value === null) {
      if (path) segments.push(path);
      path = "";
    } else path += (path ? " L " : "M ") + x(i) + " " + y(value);
  });
  if (path) segments.push(path);
  return (
    <svg
      className="request-chart"
      viewBox="0 0 370 170"
      role="img"
      aria-label={
        type === "latency"
          ? "请求耗时，灰柱为 HTTP 响应头等待或 WS 发送至首事件等待，秒"
          : type === "cache"
            ? "缓存命中百分比"
            : "请求体大小，MB"
      }
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1="38"
            x2="350"
            y1={y(f * maximum)}
            y2={y(f * maximum)}
            className="chart-grid"
          />
          <text x="29" y={y(f * maximum) + 4} textAnchor="end">
            {(f * maximum).toFixed(type === "body" ? 1 : 0)}
          </text>
        </g>
      ))}
      {type === "latency" &&
        calls.map((c, i) =>
          waits[i].ms === null ? null : (
            <rect
              key={c.id}
              x={x(i) - Math.max(1, 70 / calls.length)}
              y={y(waits[i].ms! / 1000)}
              width={Math.max(2, 140 / calls.length)}
              height={Math.max(0, 133 - y(waits[i].ms! / 1000))}
              fill="var(--wait)"
            />
          ),
        )}
      {segments.map((d, i) => (
        <path key={i} d={d} stroke={color} strokeWidth="2" fill="none" />
      ))}
      {calls.map((c, i) => (
        <g key={c.id}>
          {c.id === selected && (
            <line
              x1={x(i)}
              x2={x(i)}
              y1="18"
              y2="139"
              stroke="var(--muted)"
              strokeDasharray="3 4"
            />
          )}
          {values[i] !== null && calls.length < 70 && (
            <circle cx={x(i)} cy={y(values[i]!)} r="2.4" fill={color} />
          )}
          <rect
            className="chart-hit"
            x={x(i) - 155 / calls.length}
            y="16"
            width={310 / calls.length}
            height="124"
            fill="transparent"
            onClick={() => onSelect(c.id)}
          >
            <title>
              {"#" + c.index + " · " + (values[i]?.toFixed(2) ?? "无数据")}
              {type === "latency" &&
                " · " + waits[i].label + " " + seconds(waits[i].ms)}
            </title>
          </rect>
        </g>
      ))}
      <text x="38" y="158">
        {calls.length ? "#" + calls[0].index : "暂无请求"}
      </text>
      <text x="350" y="158" textAnchor="end">
        {calls.length ? "#" + calls.at(-1)!.index : ""}
      </text>
    </svg>
  );
}

export function ObservationPanel({
  data,
  call,
  selectedImage,
  onImage,
  compact = false,
}: {
  data: RunData;
  call?: Call;
  selectedImage?: string;
  onImage(id: string): void;
  compact?: boolean;
}) {
  const samples = call
    ? [...new Set([...call.inputObservations, ...call.observations])].flatMap(
        (id) => data.observations.filter((o) => o.id === id),
      )
    : data.observations.slice(-4);
  const explicit = data.observations.find((o) => o.id === selectedImage);
  const input = call?.inputObservations
    .flatMap((id) => data.observations.filter((o) => o.id === id))
    .at(-1);
  const observation =
    explicit ?? input ?? samples.at(-1) ?? data.observations.at(-1);
  const isInput =
    observation && call?.inputObservations.includes(observation.id);
  const media = (o: Observation) =>
    "/api/media?" +
    new URLSearchParams({ project: data.project, run: data.run, id: o.id });
  return (
    <section
      className={"surface observation-panel" + (compact ? " compact" : "")}
    >
      <div className="surface-heading">
        <h2>{isInput ? "模型看到的画面" : "保存的观测"}</h2>
        <span>
          {call ? "请求 #" + String(call.index).padStart(3, "0") : "传感器"}
        </span>
      </div>
      <div className="screen">
        {observation ? (
          observation.mediaType.startsWith("image/") ? (
            <img
              key={observation.id}
              src={media(observation)}
              alt={
                (isInput ? "模型输入" : "保存观测") +
                " · " +
                observation.sensor +
                " · " +
                clockTime(observation.at)
              }
            />
          ) : (
            <audio controls src={media(observation)} />
          )
        ) : (
          <div className="empty-state">
            <span className="empty-symbol">◫</span>
            <h3>还没有画面</h3>
            <p>传感器保存观测后，会出现在这里。</p>
          </div>
        )}
      </div>
      <div className="screen-meta">
        <span>
          {observation
            ? (observationOrigin[observation.origin] ?? observation.origin) +
              " · " +
              clockTime(observation.at)
            : "等待传感器"}
        </span>
        {observation?.sourceSequence != null && (
          <span>源帧 {observation.sourceSequence}</span>
        )}
      </div>
      {!!samples.length && (
        <div className="sample-strip">
          {samples.map((o) => (
            <button
              key={o.id}
              className={
                "sample" + (o.id === observation?.id ? " selected" : "")
              }
              onClick={() => onImage(o.id)}
              aria-pressed={o.id === observation?.id}
            >
              {o.mediaType.startsWith("image/") ? (
                <img src={media(o)} alt="" />
              ) : (
                <span>音频</span>
              )}
              <small>
                {call?.inputObservations.includes(o.id)
                  ? "输入画面"
                  : "后续观测"}
              </small>
            </button>
          ))}
        </div>
      )}
      {observation && (
        <details className="observation-metadata">
          <summary>
            观测详情 <span>{observation.sensor}</span>
          </summary>
          <dl className="fact-grid">
            <div>
              <dt>采集</dt>
              <dd>{seconds(observation.captureMs)}</dd>
            </div>
            <div>
              <dt>编码</dt>
              <dd>{seconds(observation.encodeMs)}</dd>
            </div>
            <div>
              <dt>帧变化</dt>
              <dd>{observation.sourceSequenceDelta ?? "—"}</dd>
            </div>
            <div>
              <dt>动作后采样请求</dt>
              <dd>
                {observation.afterExecutionMs == null
                  ? "—"
                  : observation.afterExecutionMs.toFixed(1) + " ms"}
              </dd>
            </div>
          </dl>
          {observation.request && (
            <pre>{JSON.stringify(observation.request, null, 2)}</pre>
          )}
        </details>
      )}
    </section>
  );
}

function TraceList({ data, call }: { data: RunData; call?: Call }) {
  const all = data.telemetry.spans;
  const selected = call ? all.filter((s) => s.modelCallId === call.id) : all;
  const roots = new Set(selected.map((s) => s.traceId + ":" + s.spanId));
  // Expand explicit descendants; native spans may not all carry the business request ID.
  const visible = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of all)
      if (
        s.parentSpanId &&
        visible.has(s.traceId + ":" + s.parentSpanId) &&
        !visible.has(s.traceId + ":" + s.spanId)
      ) {
        visible.add(s.traceId + ":" + s.spanId);
        changed = true;
      }
  }
  // Include parents after descendants, without pulling in sibling requests.
  changed = true;
  while (changed) {
    changed = false;
    for (const s of all)
      if (
        visible.has(s.traceId + ":" + s.spanId) &&
        s.parentSpanId &&
        !visible.has(s.traceId + ":" + s.parentSpanId)
      ) {
        visible.add(s.traceId + ":" + s.parentSpanId);
        changed = true;
      }
  }
  const spans = all.filter((s) => visible.has(s.traceId + ":" + s.spanId));
  const primary = spans.filter(
    (s) =>
      s.kind !== "python" ||
      !spans.some(
        (p) =>
          p.kind === "capability" &&
          p.spanId === s.spanId &&
          p.traceId === s.traceId,
      ),
  );
  const depth = (s: TraceSpan) => {
    let n = 0,
      parent = s.parentSpanId;
    const seen = new Set([s.spanId]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const p = primary.find(
        (a) => a.traceId === s.traceId && a.spanId === parent,
      );
      if (!p) break;
      n++;
      parent = p.parentSpanId;
    }
    return Math.min(5, n);
  };
  return (
    <>
      <p className="help-text">
        按显式调用关系连接。Python
        细节合并到同一能力节点，包含关系的耗时不相加。压缩 HTTP
        仅记录到响应头，候选就绪也不代表已经应用。
      </p>
      {!primary.length ? (
        <div className="empty-state">
          <h3>没有关联的调用链</h3>
          <p>这份日志尚未记录对应的 span；可继续查看工具与事件证据。</p>
        </div>
      ) : (
        <div className="trace-list">
          {primary.map((s) => (
            <details
              className="trace-row"
              key={s.id}
              style={{ marginLeft: depth(s) * 15 }}
            >
              <summary>
                <span
                  className={"source-dot " + (s.source?.component ?? "unknown")}
                />
                <span className="trace-name">
                  <b>{s.name}</b>
                  <small>
                    {s.source?.component ?? "未标注来源"} · {s.kind}
                  </small>
                </span>
                <span className="mono">{seconds(s.durationMs)}</span>
                <span className={"outcome " + s.outcome}>
                  {s.outcome === "success" && s.kind === "compaction"
                    ? s.operation === "maintenance"
                      ? "维护结束"
                      : "候选就绪"
                    : s.outcome === "success" && s.kind === "compaction-http"
                      ? "响应头已到"
                      : outcomeLabel[s.outcome]}
                </span>
              </summary>
              <dl className="fact-grid">
                <div>
                  <dt>Trace</dt>
                  <dd>{s.traceId}</dd>
                </div>
                <div>
                  <dt>Span</dt>
                  <dd>{s.spanId}</dd>
                </div>
                {s.operationId && (
                  <div>
                    <dt>Operation</dt>
                    <dd>{s.operationId}</dd>
                  </div>
                )}
                <div>
                  <dt>开始</dt>
                  <dd>{clockTime(s.startedAt)}</dd>
                </div>
                <div>
                  <dt>来源事件</dt>
                  <dd>
                    #{s.startSeq} →{" "}
                    {s.endSeq == null ? "等待终态" : "#" + s.endSeq}
                  </dd>
                </div>
              </dl>
              {s.error && <pre className="error-text">{s.error}</pre>}
              {spans
                .filter(
                  (p) =>
                    p.kind === "python" &&
                    p.traceId === s.traceId &&
                    p.spanId === s.spanId,
                )
                .map((p) => (
                  <p className="help-text" key={p.id}>
                    Python · {p.name}{" "}
                    {p.codeSHA && "· " + p.codeSHA.slice(0, 12)}
                  </p>
                ))}
            </details>
          ))}
        </div>
      )}
    </>
  );
}

export function RequestDetails({
  data,
  call,
  panel,
  onPanel,
  onSelect,
  onInspect,
}: {
  data: RunData;
  call?: Call;
  panel: string;
  onPanel(tab: string): void;
  onSelect(id: string): void;
  onInspect(): void;
}) {
  const fallback = call
    ? sseFallbackReason(call, Date.parse(data.updatedAt))
    : null;
  const wait = call ? requestWait(call) : null;
  return (
    <section className="surface request-details">
      <div className="surface-heading">
        <h2>
          {call ? "请求 #" + String(call.index).padStart(3, "0") : "运行证据"}
        </h2>
        <button className="text-button" onClick={onInspect}>
          查看画面 ↗
        </button>
      </div>
      {call && (
        <>
          <div className="request-facts">
            <div>
              <span>总耗时</span>
              <strong>{seconds(call.durationMs)}</strong>
            </div>
            <div>
              <span>{wait!.label}</span>
              <strong>{seconds(wait!.ms)}</strong>
            </div>
            <div>
              <span>
                {call.transport === "websocket"
                  ? "首事件后完成"
                  : "响应头后完成"}
              </span>
              <strong>
                {seconds(
                  call.transport === "websocket"
                    ? call.phases.afterFirstStreamMs
                    : call.phases.afterHeadersMs,
                )}
              </strong>
            </div>
            <div>
              <span>请求体</span>
              <strong>{bytes(requestBytes(call))}</strong>
            </div>
            <div>
              <span>缓存命中</span>
              <strong>{percent(call.cacheHit)}</strong>
            </div>
          </div>
          <p className="request-caption">
            {transport(call)} · 输入 {call.inputTokens.toLocaleString()} tokens
            ·{" "}
            {call.transport === "websocket"
              ? call.wsFrames + " 个构建帧"
              : call.attempts + " 次 HTTP 尝试"}{" "}
            · {clockTime(call.at)}
            {fallback && " · SSE 回退：" + fallback}
          </p>
        </>
      )}
      <div className="detail-tabs" role="tablist" aria-label="请求证据">
        {[
          ["trace", "调用链"],
          ["tools", "工具"],
          ["skills", "技能"],
          ["events", "事件"],
        ].map(([id, text]) => (
          <button
            role="tab"
            aria-selected={panel === id}
            className={panel === id ? "active" : ""}
            key={id}
            onClick={() => onPanel(id)}
          >
            {text}
            {id === "events" && <small>{data.notices.length}</small>}
          </button>
        ))}
      </div>
      <div className="detail-body" role="tabpanel">
        {panel === "trace" ? (
          <TraceList data={data} call={call} />
        ) : panel === "tools" ? (
          <>
            {call?.tools.map((t) => (
              <article className="tool-evidence" key={t.id}>
                <div className="evidence-heading">
                  <b>{t.name}</b>
                  <span className={t.ok === false ? "error-text" : "muted"}>
                    {t.ok == null ? "执行中" : t.ok ? "完成" : "失败"}
                  </span>
                </div>
                {t.intent && <p>{t.intent}</p>}
                <pre>{t.args.command ?? JSON.stringify(t.args, null, 2)}</pre>
                <p className="help-text">
                  {t.name === "exec" &&
                    "命令执行 " + seconds(t.commandMs) + " · "}
                  工具全程 {seconds(t.durationMs)}（含后续观测）
                </p>
              </article>
            ))}
            {!call?.tools.length && (
              <p className="empty-state">这次请求没有工具调用。</p>
            )}
            <p className="help-text">
              HTTP 响应头等待和 WS
              首事件等待都包含网络与服务端处理，不能单独归因于上传或排队。
            </p>
          </>
        ) : panel === "skills" ? (
          <>
            {[...data.skills].reverse().map((e) => (
              <button
                className="evidence-row"
                key={e.seq}
                onClick={() => e.modelCallId && onSelect(e.modelCallId)}
              >
                <span className="badge">{e.action}</span>
                <span>
                  <b>{e.path}</b>
                  <small>
                    {clockTime(e.at)} ·{" "}
                    {e.ok == null ? "执行中" : e.ok ? "成功" : "失败"}
                    {e.hash ? " · " + e.hash.slice(0, 12) : ""}
                  </small>
                </span>
                <span>↗</span>
              </button>
            ))}
            {!data.skills.length && (
              <p className="empty-state">本轮没有技能读写证据。</p>
            )}
            <p className="help-text">读写成功不表示技能质量或任务能力提高。</p>
          </>
        ) : (
          <>
            {[...data.notices].reverse().map((n) => (
              <button
                className="evidence-row"
                key={n.seq}
                onClick={() => n.modelCallId && onSelect(n.modelCallId)}
              >
                <span className={"notice-dot" + (n.failed ? " failed" : "")} />
                <span>
                  <b>{n.type}</b>
                  <p>{n.text}</p>
                  {n.details && (
                    <dl className="fact-grid">
                      {n.details.map((d) => (
                        <div key={d.label}>
                          <dt>{d.label}</dt>
                          <dd>{d.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <small>{clockTime(n.at)}</small>
                </span>
              </button>
            ))}
            {!data.notices.length && (
              <p className="empty-state">本轮没有错误或压缩事件。</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
