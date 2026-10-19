import type {
  Event,
  NativeLoop,
  RunTelemetry,
  SpanOutcome,
  SpanStats,
  TraceSpan,
} from "./types";

type SpanKind = TraceSpan["kind"];
const operations: {
  kind: SpanKind;
  start: string;
  ends: string[];
  startStage?: string;
  endStages?: string[];
  name?: string;
  operation?: string;
}[] = [
  { kind: "shiori", start: "shiori_span_start", ends: ["shiori_span_end"] },
  { kind: "capability", start: "capability_start", ends: ["capability_end"] },
  {
    kind: "python",
    start: "python_capability",
    ends: ["python_capability_result"],
    operation: "invoke",
  },
  {
    kind: "discovery",
    start: "python_capabilities_start",
    ends: ["python_capabilities"],
    operation: "discover",
  },
  {
    kind: "device",
    start: "command",
    ends: ["execution", "execution_error"],
    operation: "execute",
  },
  {
    kind: "device",
    start: "observation_start",
    ends: ["observation_end", "observation_error"],
    operation: "observe",
  },
  {
    kind: "compaction",
    start: "compaction_speculation",
    startStage: "started",
    ends: ["compaction_speculation"],
    endStages: ["armed", "failed", "cancelled"],
    name: "准备压缩候选",
    operation: "prepare_compaction",
  },
  {
    kind: "compaction-http",
    start: "compaction_http_start",
    ends: ["compaction_http_end", "compaction_http_error"],
    name: "压缩 HTTP · 响应头",
    operation: "fetch_compaction_headers",
  },
  {
    kind: "compaction",
    start: "auto_compaction_start",
    ends: ["auto_compaction_end"],
    name: "压缩维护",
    operation: "maintenance",
  },
];
const key = (event: Event) =>
  JSON.stringify([event.trace.epoch, event.trace.traceId, event.trace.spanId]);
const identified = (event: Event) =>
  !!event.trace.traceId && !!event.trace.spanId;
const duration = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const errorText = (value: unknown) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/** Nearest-rank percentile; unknown or incomplete measurements never become zero. */
export function p95(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
}

function stats(spans: TraceSpan[]): SpanStats {
  const times = spans
    .flatMap((span) => (span.durationMs === null ? [] : [span.durationMs]))
    .sort((a, b) => a - b);
  const outcomes: Record<SpanOutcome, number> = {
    success: 0,
    error: 0,
    cancelled: 0,
    pending: 0,
    unknown: 0,
  };
  for (const span of spans) outcomes[span.outcome]++;
  return {
    started: spans.length,
    outcomes,
    durationMs: {
      median: times.length
        ? (times[Math.floor((times.length - 1) / 2)] +
            times[Math.floor(times.length / 2)]) /
          2
        : null,
      p95: p95(times),
    },
  };
}

/** Pair explicit identities, including late cleanup, without guessing from names or ordering. */
export function projectTelemetry(
  selected: Event[],
  allEvents = selected,
): RunTelemetry {
  const sources = new Map<string, number>();
  for (const event of selected) {
    const component = event.source?.component ?? "unlabelled";
    sources.set(component, (sources.get(component) ?? 0) + 1);
  }
  const related = new Map<string, Event["trace"]>();
  // OMP opens its native span before ModelTrace assigns a modelCallId. Later
  // model_start/tool_start facts carry both identities; join only that exact span.
  for (const event of allEvents)
    if (identified(event)) {
      const identity = key(event);
      related.set(identity, { ...related.get(identity), ...event.trace });
    }
  const spans: TraceSpan[] = [];
  const deviceCommands = new Set(
    allEvents.filter((event) => event.type === "command" && identified(event)).map(key),
  );
  for (const definition of operations) {
    const finishes = new Map<string, Event>();
    for (const event of allEvents)
      if (
        identified(event) &&
        definition.ends.includes(event.type) &&
        (!definition.endStages ||
          definition.endStages.includes(event.data.stage)) &&
        !finishes.has(key(event))
      )
        finishes.set(key(event), event);
    for (const start of selected) {
      if (
        start.type !== definition.start ||
        !identified(start) ||
        (definition.startStage && start.data.stage !== definition.startStage)
      )
        continue;
      // New controller calls also emit observation details on the same span.
      // Only historical captures without a command need a separate projection.
      if (start.type === "observation_start" && deviceCommands.has(key(start))) continue;
      const finish = finishes.get(key(start));
      const trace = { ...related.get(key(start)), ...start.trace };
      const result = finish?.data;
      let outcome: SpanOutcome = !finish
        ? "pending"
        : ["success", "error", "cancelled"].includes(result?.outcome)
          ? result!.outcome
          : "unknown";
      if (finish && outcome === "unknown") {
        if (definition.kind === "compaction") {
          if (definition.operation === "maintenance")
            outcome = result?.aborted
              ? "cancelled"
              : result?.errorMessage || result?.error
                ? "error"
                : "success";
          else
            outcome =
              result?.stage === "armed"
                ? "success"
                : result?.stage === "cancelled"
                  ? "cancelled"
                  : "error";
        }
        if (definition.kind === "compaction-http")
          outcome =
            finish.type === "compaction_http_error"
              ? result?.aborted
                ? "cancelled"
                : "error"
              : typeof result?.status === "number"
                ? result.status >= 400
                  ? "error"
                  : "success"
                : "unknown";
      }
      let durationMs = duration(result?.durationMs);
      // Device events are forwarded by RSA. Only the original clock measures
      // the device span; receipt timestamps include transport and scheduling.
      if (
        definition.kind === "device" &&
        durationMs === null &&
        start.origin &&
        finish?.origin &&
        start.origin.clockId === finish.origin.clockId
      ) {
        durationMs = duration(finish.origin.atMs - start.origin.atMs);
      }
      spans.push({
        id: `${definition.kind}:${trace.traceId}:${trace.spanId}`,
        kind: definition.kind,
        traceId: trace.traceId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId,
        modelCallId: trace.modelCallId,
        toolCallId: trace.toolCallId,
        operationId: trace.operationId,
        source: start.source,
        name: String(
          definition.name ??
            start.data.name ??
            start.data.id ??
            start.data.capabilityId ??
            start.data.controllerId ??
            start.data.sensorId ??
            (definition.kind === "discovery"
              ? "Python discovery"
              : (start.data.operation ?? definition.kind)),
        ),
        operation:
          definition.operation ?? start.data.operation ?? start.data.action,
        startedAt: start.origin?.at ?? start.at,
        endedAt: finish?.origin?.at ?? finish?.at ?? null,
        startSeq: start.seq,
        endSeq: finish?.seq ?? null,
        outcome,
        durationMs,
        codeSHA: start.data.codeSHA,
        error: errorText(result?.errorMessage ?? result?.error),
      });
    }
  }
  spans.sort((a, b) => a.startSeq - b.startSeq || a.kind.localeCompare(b.kind));
  const nativeStarts = new Set(
    selected
      .filter(
        (event) =>
          event.type === "shiori_span_start" &&
          event.data.operation === "invoke_agent" &&
          identified(event),
      )
      .map(key),
  );
  const nativeLoops: NativeLoop[] = allEvents
    .filter(
      (event) =>
        event.type === "shiori_run_end" && nativeStarts.has(key(event)),
    )
    .map((event) => ({
      traceId: event.trace.traceId,
      spanId: event.trace.spanId,
      at: event.at,
      source: event.source,
      summary: event.data.summary ?? {},
      coverage: event.data.coverage ?? {},
    }));
  const of = (kind: SpanKind) => spans.filter((span) => span.kind === kind);
  return {
    sources: [...sources]
      .map(([component, count]) => ({ component, count }))
      .sort(
        (a, b) => b.count - a.count || a.component.localeCompare(b.component),
      ),
    spans,
    // These summaries are overlapping views. Native usage and Python details
    // must not be added to model usage or the public capability duration.
    shiori: { stats: stats(of("shiori")), nativeLoops },
    capabilities: {
      stats: stats(of("capability")),
      python: stats(of("python")),
      discovery: stats(of("discovery")),
    },
    devices: stats(of("device")),
  };
}
