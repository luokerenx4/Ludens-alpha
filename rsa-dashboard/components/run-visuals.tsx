"use client";
import { useEffect, useMemo, useState } from "react";
import { useBufferedMedia } from "./use-buffered-media";
import type { Call, Observation, PerceptionSnapshot, RunData, TraceSpan } from "@/lib/types";
import type { TimelineRecordDetail } from "@/lib/timeline-record";
import { requestWait, sseFallbackReason } from "@/lib/transport";
import { mediaFailureMessage, observationTime, perceptionAgeMs, perceptionStateLabel, samplingDurationMs, selectObservations } from "./observation-model";

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
  observe_hook: "工作区 observe",
  perception: "工作区感知",
  tool_result: "工具返回的图像",
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

function TextObservation({ url }: { url: string }) {
  const [text, setText] = useState("载入文字观测…");
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(mediaFailureMessage(response.status));
        const value = await response.text();
        if (!controller.signal.aborted) setText(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setText(String(error));
      });
    return () => controller.abort();
  }, [url]);
  return <pre className="observation-text">{text}</pre>;
}

function MediaFailure({ url }: { url: string }) {
  const [message, setMessage] = useState("无法读取观测文件");
  useEffect(() => {
    const controller = new AbortController();
    // Only failed media requests need a status lookup; normal images stream
    // directly to the browser without a second copy in application memory.
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(response => {
        void response.body?.cancel();
        if (!controller.signal.aborted) setMessage(mediaFailureMessage(response.status));
      }).catch(() => {});
    return () => controller.abort();
  }, [url]);
  return <span role="status">{message}</span>;
}

function BufferedObservationImage({ url, alt }: { url: string; alt: string }) {
  const target = useMemo(() => ({ key: url, value: alt, urls: [url] }), [url, alt]);
  const { displayed, pending } = useBufferedMedia("observation", target);
  const image = displayed?.images.get(displayed.key);
  return <div className="buffered-observation" aria-busy={pending}>
    {image?.error ? <span role="status">{image.error}</span> : image ?
      <img src={image.src} width={image.width} height={image.height} alt={displayed!.value} /> : <span>正在载入画面…</span>}
    {pending && displayed && <small role="status">正在载入所选观测 · 暂留 {displayed.value}</small>}
  </div>;
}

function ObservationMedia({ observation, url, alt = "", thumbnail = false }: {
  observation: Observation; url: string; alt?: string; thumbnail?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (observation.mediaStorage === "unrecorded") return <span>未录制 · 仅保留交付记录</span>;
  if (failed) return <MediaFailure url={url} />;
  if (observation.mediaType.startsWith("image/"))
    return thumbnail ? <img src={url} alt={alt} onError={() => setFailed(true)} /> : <BufferedObservationImage url={url} alt={alt} />;
  if (thumbnail) return <span>{observation.mediaType.startsWith("audio/") ? "音频" : "文字"}</span>;
  if (observation.mediaType.startsWith("audio/"))
    return <audio controls preload="none" src={url} onError={() => setFailed(true)} />;
  return <TextObservation url={url} />;
}

function TimelineRecordData({ url }: { url: string }) {
  const [record, setRecord] = useState<TimelineRecordDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(mediaFailureMessage(response.status));
      setRecord(await response.json());
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url]);
  if (error) return <p role="status">{error}</p>;
  if (!record) return <p role="status">正在读取时空记录…</p>;
  if (record.data === undefined && record.space === undefined) return <p>此记录没有额外的数据或空间标注。</p>;
  return <pre className="observation-text">{JSON.stringify({ data: record.data, space: record.space }, null, 2)}</pre>;
}

function TimelineRecordDetails({ snapshot, url }: { snapshot: PerceptionSnapshot; url: string }) {
  const [open, setOpen] = useState(false);
  return <details className="observation-metadata" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>记录 #{snapshot.sequence} · 感知数据与空间信息</summary>
    {open && <TimelineRecordData key={url} url={url} />}
  </details>;
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
  const { inputs, others, observation, showingInput } = selectObservations(
    data.observations, call, selectedImage,
  );
  const text = showingInput ? call?.inputText : observation?.text;
  const perception = observation?.perception ?? (showingInput ? call?.perception : undefined);
  const snapshot = perception?.snapshot;
  const recordRead = showingInput ? call?.perception : perception;
  const records = (recordRead?.records?.map(record => record.snapshot) ?? (recordRead?.snapshot ? [recordRead.snapshot] : []))
    .filter(record => record.timeline);
  const age = perceptionAgeMs(perception);
  const samplingMs = samplingDurationMs(snapshot);
  const timestamp = (o: Observation) => o.perception ? o.perception.snapshot?.recordedAt : o.at;
  const duration = (ms: number | null | undefined) => ms != null && ms < 1000
    ? ms.toFixed(1) + " ms" : seconds(ms);
  const media = (o: Observation) =>
    "/api/media?" +
    new URLSearchParams({ project: data.project, run: data.run, id: o.id });
  const samples = (items: Observation[], label: string) => (
    <div className="sample-strip">
      {items.map((o) => (
        <button
          key={o.id}
          className={"sample" + (o.id === observation?.id ? " selected" : "")}
          onClick={() => onImage(o.id)}
          aria-pressed={o.id === observation?.id}
          title={[o.controller, timestamp(o)].filter(Boolean).join(" · ")}
        >
          <ObservationMedia key={media(o)} observation={o} url={media(o)} thumbnail />
          <small>{o.mediaStorage === "unrecorded" ? "未录制的观测" : label}</small>
          <small>{observationTime(timestamp(o))}</small>
        </button>
      ))}
    </div>
  );
  return (
    <section
      className={"surface observation-panel" + (compact ? " compact" : "")}
    >
      <div className="surface-heading">
        <h2>{showingInput ? "模型输入的观测" : "采样与中间产物"}</h2>
        <span>
          {call ? "请求 #" + String(call.index).padStart(3, "0") : "等待模型请求"}
        </span>
      </div>
      {data.perception && (
        <div className="screen-meta">
          <span>感知进程 · {perceptionStateLabel[data.perception.state]}</span>
          {data.perception.pid && <span>PID {data.perception.pid}</span>}
          {data.perception.generation && <span title={data.perception.generation}>代次 {data.perception.generation.slice(0, 8)}</span>}
          {data.perception.codeSHA && <span title={data.perception.codeSHA}>版本 {data.perception.codeSHA.slice(0, 8)}</span>}
        </div>
      )}
      {perception && (
        <details className="observation-metadata" open={perception.status.state !== "ready"}>
          <summary>
            本次读取 · 感知进程{perceptionStateLabel[perception.status.state]}
            {perception.reused === true ? " · 复用已有结果" : ""}
          </summary>
          <dl className="fact-grid">
            <div><dt>读取耗时</dt><dd>{duration(perception.durationMs)}</dd></div>
            <div><dt>读取时结果年龄</dt><dd>{age === null ? "未知" : seconds(age)}</dd></div>
            <div><dt>记录时间</dt><dd title={snapshot?.recordedAt}>{observationTime(snapshot?.recordedAt)}</dd></div>
            <div><dt>采样耗时</dt><dd title={snapshot?.sampling?.clock}>{samplingMs === null ? "未知" : duration(samplingMs)}</dd></div>
            <div><dt>记录代次</dt><dd title={snapshot?.generation ?? undefined}>{snapshot?.generation?.slice(0, 12) ?? "未知"}</dd></div>
            <div><dt>来源时刻</dt><dd title={snapshot?.sampledAt}>{observationTime(snapshot?.sampledAt)}</dd></div>
            {snapshot && <div><dt>记录序号</dt><dd>{snapshot.sequence}</dd></div>}
          </dl>
          {perception.query && <details>
            <summary>读取范围{perception.hasMore ? " · 尚有后续记录" : ""}</summary>
            <pre className="observation-text">{JSON.stringify({ query: perception.query,
              hasMore: perception.hasMore, nextAfter: perception.nextAfter }, null, 2)}</pre>
          </details>}
          {(perception.error || perception.status.error) && (
            <pre className="observation-text">{perception.error || perception.status.error}</pre>
          )}
          {snapshot?.sources && (
            <details>
              <summary>采样来源</summary>
              <pre className="observation-text">{JSON.stringify(snapshot.sources, null, 2)}</pre>
            </details>
          )}
        </details>
      )}
      {records.map(record => <TimelineRecordDetails key={record.timeline!.recordId} snapshot={record}
        url={"/api/media?" + new URLSearchParams({ project: data.project, run: data.run,
          record: record.timeline!.recordId, sequence: String(record.timeline!.sequence),
          ...(showingInput && call ? { call: call.id } : observation ? { id: observation.id } : {}) })} />)}
      <div className="screen">
        {observation ? (
          <ObservationMedia key={data.project + ":" + data.run} observation={observation} url={media(observation)}
            alt={(showingInput ? "模型输入" : "保存观测") + " · " + observation.controller + " · " + observationTime(timestamp(observation))} />
        ) : text ? (
          <pre className="observation-text">{text}</pre>
        ) : records.length ? (
          <p>本次输入包含 {records.length} 条时空记录。展开上方详情查看感知数据与空间信息。</p>
        ) : (
          <div className="empty-state">
            <span className="empty-symbol">◫</span>
            <h3>{call ? "本次请求没有可展示的输入画面" : "等待模型观测"}</h3>
            <p>{perception?.status.state === "unimplemented"
              ? "工作区尚未实现感知，当前循环没有环境观测。"
              : "这里按模型请求展示实际输入的观测。"}</p>
          </div>
        )}
      </div>
      <div className="screen-meta">
        <span>
          {observation
            ? (observationOrigin[observation.origin] ?? observation.origin) +
              " · " +
              (observation.perception ? "记录于 " : "") + observationTime(timestamp(observation))
            : text ? "文字观测" : records.length ? "时空记录" : "暂无输入媒体"}
        </span>
        {observation?.sourceSequence != null && (
          <span>源帧 {observation.sourceSequence}</span>
        )}
        {!showingInput && (
          <button className="text-button" onClick={() => onImage("")}>
            返回模型输入
          </button>
        )}
      </div>
      {!!inputs.length && samples(inputs, "模型输入")}
      {observation && text && (
        <details className="observation-metadata">
          <summary>{showingInput ? "随观测发送的文字" : "观测文字"}</summary>
          <pre className="observation-text">{text}</pre>
        </details>
      )}
      {!!others.length && (
        <details className="observation-metadata">
          <summary>其他采样与产物 · {others.length}</summary>
          <p>采集和处理的交付记录；仅录制的观测提供历史媒体。</p>
          {samples(others, "已录制的观测")}
        </details>
      )}
      {observation && (
        <details className="observation-metadata">
          <summary>
            观测详情 <span>{observation.controller}</span>
          </summary>
          <dl className="fact-grid">
            {observation.hook && (
              <div>
                <dt>Observe 版本</dt>
                <dd title={observation.hook.codeSHA}>{observation.hook.codeSHA.slice(0, 12)}</dd>
              </div>
            )}
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
                <span className={"outcome " + (s.kind === "python-local" && s.outcome === "error" ? "unknown" : s.outcome)}>
                  {s.kind === "python-local" && s.outcome === "error" ? "抛出异常"
                    : s.outcome === "success" && s.kind === "compaction"
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
              {s.kind === "python-local" && s.outcome === "error" && <p className="help-text">记录函数抛出的异常；外层可能捕获它，不能据此判定命令或测试失败。</p>}
              {s.error && <pre className={s.kind === "python-local" ? "help-text" : "error-text"}>{s.error}</pre>}
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
                  工具全程 {seconds(t.durationMs)}
                  {t.name === "bash"
                    ? "（至工具返回，不代表后台进程已结束）"
                    : "（含结果整理）"}
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
            <p className="help-text">近期最多 100 条技能证据；完整记录可在运行页的活动日志中搜索。</p>
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
              <p className="empty-state">当前范围没有技能读写证据。</p>
            )}
            <p className="help-text">读写成功不表示技能质量或任务能力提高。</p>
          </>
        ) : (
          <>
            <p className="help-text">近期最多 100 条事件；完整历史可在运行页的活动日志中按类型筛选。</p>
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
