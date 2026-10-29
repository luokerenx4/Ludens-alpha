"use client";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/lib/locale";
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
export const transport = (c: Call, t: (key: string) => string) =>
  c.transport === "websocket"
    ? "WS · " +
      (c.incremental == null ? t("transport.unknown") : c.incremental ? t("transport.incremental") : t("transport.full"))
    : c.transport === "sse"
      ? "SSE"
      : t("transport.unrecorded");
const observationOriginKeys = [
  "prompt_start",
  "tool_batch",
  "explicit",
  "cli",
  "observe_hook",
  "perception",
  "tool_result",
];
export function observationOrigin(origin: string, t: (key: string) => string): string {
  return observationOriginKeys.includes(origin) ? t("origin." + origin) : origin;
}

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
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
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
          ? t("chart.ariaLatency")
          : type === "cache"
            ? t("chart.ariaCache")
            : t("chart.ariaBody")
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
              stroke="var(--muted-foreground)"
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
              {"#" + c.index + " · " + (values[i]?.toFixed(2) ?? t("chart.noData"))}
              {type === "latency" &&
                " · " + waits[i].label + " " + seconds(waits[i].ms)}
            </title>
          </rect>
        </g>
      ))}
      <text x="38" y="158">
        {calls.length ? "#" + calls[0].index : t("chart.noRequests")}
      </text>
      <text x="350" y="158" textAnchor="end">
        {calls.length ? "#" + calls.at(-1)!.index : ""}
      </text>
    </svg>
  );
}

function TextObservation({ url }: { url: string }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const [text, setText] = useState(t("textObservation.loading"));
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(mediaFailureMessage(response.status, rootT));
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
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const [message, setMessage] = useState(t("mediaFailure.default"));
  useEffect(() => {
    const controller = new AbortController();
    // Only failed media requests need a status lookup; normal images stream
    // directly to the browser without a second copy in application memory.
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(response => {
        void response.body?.cancel();
        if (!controller.signal.aborted) setMessage(mediaFailureMessage(response.status, rootT));
      }).catch(() => {});
    return () => controller.abort();
  }, [url]);
  return <span role="status">{message}</span>;
}

function BufferedObservationImage({ url, alt }: { url: string; alt: string }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const target = useMemo(() => ({ key: url, value: alt, urls: [url] }), [url, alt]);
  const { displayed, pending } = useBufferedMedia("observation", target);
  const image = displayed?.images.get(displayed.key);
  return <div className="buffered-observation" aria-busy={pending}>
    {image?.error ? <span role="status">{image.error}</span> : image ?
      <img src={image.src} width={image.width} height={image.height} alt={displayed!.value} /> : <span>{t("buffered.loading")}</span>}
    {pending && displayed && <small role="status">{t("buffered.pendingKeep")} {displayed.value}</small>}
  </div>;
}

function ObservationMedia({ observation, url, alt = "", thumbnail = false }: {
  observation: Observation; url: string; alt?: string; thumbnail?: boolean;
}) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (observation.mediaStorage === "unrecorded") return <span>{t("media.unrecorded")}</span>;
  if (failed) return <MediaFailure url={url} />;
  if (observation.mediaType.startsWith("image/"))
    return thumbnail ? <img src={url} alt={alt} onError={() => setFailed(true)} /> : <BufferedObservationImage url={url} alt={alt} />;
  if (thumbnail) return <span>{observation.mediaType.startsWith("audio/") ? t("media.audio") : t("media.text")}</span>;
  if (observation.mediaType.startsWith("audio/"))
    return <audio controls preload="none" src={url} onError={() => setFailed(true)} />;
  return <TextObservation url={url} />;
}

function TimelineRecordData({ url }: { url: string }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const [record, setRecord] = useState<TimelineRecordDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(mediaFailureMessage(response.status, rootT));
      setRecord(await response.json());
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url]);
  if (error) return <p role="status">{error}</p>;
  if (!record) return <p role="status">{t("record.loading")}</p>;
  if (record.data === undefined && record.space === undefined) return <p>{t("record.empty")}</p>;
  return <pre className="observation-text">{JSON.stringify({ data: record.data, space: record.space }, null, 2)}</pre>;
}

function TimelineRecordDetails({ snapshot, url }: { snapshot: PerceptionSnapshot; url: string }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const [open, setOpen] = useState(false);
  return <details className="observation-metadata" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("record.summary")} #{snapshot.sequence} · {t("record.detail")}</summary>
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
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const { inputs, others, observation, showingInput } = selectObservations(
    data.observations, call, selectedImage,
  );
  const text = showingInput ? call?.inputText : observation?.text;
  const perception = observation?.perception ?? (showingInput ? call?.perception : undefined);
  const snapshot = perception?.snapshot;
  const recordRead = showingInput ? call?.perception : perception;
  const reads = showingInput ? call?.perceptionReads ?? (recordRead ? [recordRead] : []) : recordRead ? [recordRead] : [];
  const records = [...new Map(reads.filter(read => !read.deliveryError).flatMap(read => read.records?.map(record => record.snapshot)
    ?? (read.snapshot ? [read.snapshot] : [])).filter(record => record.timeline)
    .map(record => [record.timeline!.recordId, record])).values()];
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
          <small>{o.mediaStorage === "unrecorded" ? t("panel.unrecorded") : label}</small>
          <small>{observationTime(timestamp(o), t)}</small>
        </button>
      ))}
    </div>
  );
  return (
    <section
      className={"surface observation-panel" + (compact ? " compact" : "")}
    >
      <div className="surface-heading">
        <h2>{showingInput ? t("panel.inputTitle") : t("panel.samplesTitle")}</h2>
        <span>
          {call ? t("panel.request") + " #" + String(call.index).padStart(3, "0") : t("panel.waitingRequest")}
        </span>
      </div>
      {data.perception && (
        <div className="screen-meta">
          <span>{t("panel.perceptionProcess")} · {perceptionStateLabel(data.perception.state, rootT)}</span>
          {data.perception.pid && <span>PID {data.perception.pid}</span>}
          {data.perception.generation && <span title={data.perception.generation}>{t("panel.generation")} {data.perception.generation.slice(0, 8)}</span>}
          {data.perception.codeSHA && <span title={data.perception.codeSHA}>{t("panel.version")} {data.perception.codeSHA.slice(0, 8)}</span>}
        </div>
      )}
      {perception && (
        <details className="observation-metadata" open={perception.ok === false || !!perception.deliveryError}>
          <summary>
            {t("panel.thisQuery")} · {perception.ok === true ? t("panel.querySuccess") : perception.ok === false ? t("panel.queryFailed") : t("panel.queryUnknown")}
            {perception.deliveryError ? " · " + t("panel.deliveryFailed") : ""}
            {perception.legacyRepeated === true ? " · " + t("panel.legacyRepeated") : ""}
          </summary>
          <dl className="fact-grid">
            <div><dt>{t("fact.readMs")}</dt><dd>{duration(perception.durationMs)}</dd></div>
            <div><dt>{t("fact.ageAtRead")}</dt><dd>{age === null ? t("unknown") : seconds(age)}</dd></div>
            <div><dt>{t("fact.recordedAt")}</dt><dd title={snapshot?.recordedAt}>{observationTime(snapshot?.recordedAt, rootT)}</dd></div>
            <div><dt>{t("fact.samplingMs")}</dt><dd title={snapshot?.sampling?.clock}>{samplingMs === null ? t("unknown") : duration(samplingMs)}</dd></div>
            <div><dt>{t("fact.generation")}</dt><dd title={snapshot?.generation ?? undefined}>{snapshot?.generation?.slice(0, 12) ?? t("unknown")}</dd></div>
            <div><dt>{t("fact.sourceTime")}</dt><dd title={snapshot?.sampledAt}>{observationTime(snapshot?.sampledAt, rootT)}</dd></div>
            {snapshot && <div><dt>{t("fact.sequence")}</dt><dd>{snapshot.sequence}</dd></div>}
          </dl>
          {perception.query && <details>
            <summary>{t("panel.readRange")}{perception.hasMore ? " · " + t("panel.hasMore") : ""}</summary>
            <pre className="observation-text">{JSON.stringify({ query: perception.query,
              hasMore: perception.hasMore, nextAfter: perception.nextAfter, availability: perception.availability }, null, 2)}</pre>
          </details>}
          {(perception.deliveryError || perception.error || perception.status?.error) && (
            <pre className="observation-text">{perception.deliveryError || perception.error || perception.status?.error}</pre>
          )}
          {snapshot?.sources && (
            <details>
              <summary>{t("panel.samplingSources")}</summary>
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
            alt={(showingInput ? t("panel.altInput") : t("panel.altSaved")) + " · " + observation.controller + " · " + observationTime(timestamp(observation), t)} />
        ) : text ? (
          <pre className="observation-text">{text}</pre>
        ) : records.length ? (
          <p>{t("panel.recordsPrefix")} {records.length} {t("panel.recordsSuffix")}</p>
        ) : (
          <div className="empty-state">
            <span className="empty-symbol">◫</span>
            <h3>{call ? t("empty.noInput") : t("empty.waiting")}</h3>
            <p>{perception?.status?.state === "unimplemented"
              ? t("empty.unimplementedHint")
              : t("empty.hint")}</p>
          </div>
        )}
      </div>
      <div className="screen-meta">
        <span>
          {observation
            ? (observationOrigin(observation.origin, t) +
              " · " +
              (observation.perception ? t("meta.recordedAt") : "") + observationTime(timestamp(observation), t))
            : text ? t("meta.textObservation") : records.length ? t("meta.records") : t("meta.noMedia")}
        </span>
        {observation?.sourceSequence != null && (
          <span>{t("meta.sourceFrame")} {observation.sourceSequence}</span>
        )}
        {observation?.timeline?.video && <span>{t("meta.videoRestore")}</span>}
        {!showingInput && (
          <button className="text-button" onClick={() => onImage("")}>
            {t("meta.backToInput")}
          </button>
        )}
      </div>
      {!!inputs.length && samples(inputs, t("panel.modelInput"))}
      {observation && text && (
        <details className="observation-metadata">
          <summary>{showingInput ? t("panel.textWithObservation") : t("panel.observationText")}</summary>
          <pre className="observation-text">{text}</pre>
        </details>
      )}
      {!!others.length && (
        <details className="observation-metadata">
          <summary>{t("panel.otherSamples")} · {others.length}</summary>
          <p>{t("panel.otherHint")}</p>
          {samples(others, t("panel.recorded"))}
        </details>
      )}
      {observation && (
        <details className="observation-metadata">
          <summary>
            {t("panel.observationDetails")} <span>{observation.controller}</span>
          </summary>
          <dl className="fact-grid">
            {observation.hook && (
              <div>
                <dt>{t("panel.observeVersion")}</dt>
                <dd title={observation.hook.codeSHA}>{observation.hook.codeSHA.slice(0, 12)}</dd>
              </div>
            )}
            <div>
              <dt>{t("panel.capture")}</dt>
              <dd>{seconds(observation.captureMs)}</dd>
            </div>
            <div>
              <dt>{t("panel.encode")}</dt>
              <dd>{seconds(observation.encodeMs)}</dd>
            </div>
            <div>
              <dt>{t("panel.frameDelta")}</dt>
              <dd>{observation.sourceSequenceDelta ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("panel.afterExecution")}</dt>
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
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
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
        {t("trace.help")}
      </p>
      {!primary.length ? (
        <div className="empty-state">
          <h3>{t("trace.emptyTitle")}</h3>
          <p>{t("trace.emptyHint")}</p>
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
                    {s.source?.component ?? t("trace.unknownSource")} · {s.kind}
                  </small>
                </span>
                <span className="mono">{seconds(s.durationMs)}</span>
                <span className={"outcome " + (s.kind === "python-local" && s.outcome === "error" ? "unknown" : s.outcome)}>
                  {s.kind === "python-local" && s.outcome === "error" ? t("trace.threw")
                    : s.outcome === "success" && s.kind === "compaction"
                    ? s.operation === "maintenance"
                      ? t("trace.maintenanceDone")
                      : t("trace.candidateReady")
                    : s.outcome === "success" && s.kind === "compaction-http"
                      ? t("trace.headersArrived")
                      : t("outcome." + s.outcome)}
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
                  <dt>{t("trace.startedAt")}</dt>
                  <dd>{clockTime(s.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t("trace.sourceEvents")}</dt>
                  <dd>
                    #{s.startSeq} →{" "}
                    {s.endSeq == null ? t("trace.waitingFinal") : "#" + s.endSeq}
                  </dd>
                </div>
              </dl>
              {s.kind === "python-local" && s.outcome === "error" && <p className="help-text">{t("trace.pythonLocalNote")}</p>}
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
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const fallback = call
    ? sseFallbackReason(call, Date.parse(data.updatedAt))
    : null;
  const wait = call ? requestWait(call) : null;
  return (
    <section className="surface request-details">
      <div className="surface-heading">
        <h2>
          {call ? t("panel.request") + " #" + String(call.index).padStart(3, "0") : t("request.runEvidence")}
        </h2>
        <button className="text-button" onClick={onInspect}>
          {t("request.viewImage")}
        </button>
      </div>
      {call && (
        <>
          <div className="request-facts">
            <div>
              <span>{t("request.totalTime")}</span>
              <strong>{seconds(call.durationMs)}</strong>
            </div>
            <div>
              <span>{wait!.label}</span>
              <strong>{seconds(wait!.ms)}</strong>
            </div>
            <div>
              <span>
                {call.transport === "websocket"
                  ? t("request.afterFirstEvent")
                  : t("request.afterHeaders")}
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
              <span>{t("request.body")}</span>
              <strong>{bytes(requestBytes(call))}</strong>
            </div>
            <div>
              <span>{t("request.cacheHit")}</span>
              <strong>{percent(call.cacheHit)}</strong>
            </div>
          </div>
          <p className="request-caption">
            {transport(call, t)} · {t("request.input")} {call.inputTokens.toLocaleString()} tokens
            ·{" "}
            {call.transport === "websocket"
              ? call.wsFrames + " " + t("request.frames")
              : call.attempts + " " + t("request.attempts")}{" "}
            · {clockTime(call.at)}
            {fallback && " · " + t("request.sseFallback") + fallback}
          </p>
        </>
      )}
      <div className="detail-tabs" role="tablist" aria-label={t("request.evidenceLabel")}>
        {[
          ["trace", t("tabs.trace")],
          ["tools", t("tabs.tools")],
          ["skills", t("tabs.skills")],
          ["events", t("tabs.events")],
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
            {call?.tools.map((tool) => (
              <article className="tool-evidence" key={tool.id}>
                <div className="evidence-heading">
                  <b>{tool.name}</b>
                  <span className={tool.ok === false ? "error-text" : "muted"}>
                    {tool.ok == null ? t("tools.running") : tool.ok ? t("outcome.success") : t("outcome.error")}
                  </span>
                </div>
                {tool.intent && <p>{tool.intent}</p>}
                <pre>{tool.args.command ?? JSON.stringify(tool.args, null, 2)}</pre>
                <p className="help-text">
                  {tool.name === "exec" &&
                    t("tools.execPrefix") + " " + seconds(tool.commandMs) + " · "}
                  {t("tools.wholeTool")} {seconds(tool.durationMs)}
                  {tool.name === "bash"
                    ? t("tools.bashNote")
                    : t("tools.genericNote")}
                </p>
              </article>
            ))}
            {!call?.tools.length && (
              <p className="empty-state">{t("tools.empty")}</p>
            )}
            <p className="help-text">
              {t("tools.waitNote")}
            </p>
          </>
        ) : panel === "skills" ? (
          <>
            <p className="help-text">{t("skills.help")}</p>
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
                    {e.ok == null ? t("tools.running") : e.ok ? t("outcome.success") : t("outcome.error")}
                    {e.hash ? " · " + e.hash.slice(0, 12) : ""}
                  </small>
                </span>
                <span>↗</span>
              </button>
            ))}
            {!data.skills.length && (
              <p className="empty-state">{t("skills.empty")}</p>
            )}
            <p className="help-text">{t("skills.hint")}</p>
          </>
        ) : (
          <>
            <p className="help-text">{t("events.help")}</p>
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
              <p className="empty-state">{t("events.empty")}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
