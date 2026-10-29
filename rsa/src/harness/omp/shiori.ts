import type { AgentTelemetryConfig, TelemetryHookContext } from "@oh-my-pi/pi-agent-core";
import { SpanStatusCode } from "@opentelemetry/api";
import { AlwaysOnSampler, BasicTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { EventLog, EventTrace } from "../events.ts";

/** Shiori names the agent-loop role; OMP is this host's current implementation. */
export const SHIORI_SOURCE = {
  component: "shiori", implementation: "omp", implementationVersion: "18.9.1",
} as const;

function outcome(span: ReadableSpan) {
  const status = span.attributes["omp.gen_ai.tool.status"];
  const finishes = span.attributes["gen_ai.response.finish_reasons"];
  if (status === "aborted" || span.attributes["error.type"] === "aborted" || span.attributes["error.type"] === "tool_aborted" || span.attributes["error.type"] === "AbortError"
    || (Array.isArray(finishes) && finishes.some(value => value === "aborted"))) return "cancelled";
  return span.status.code === SpanStatusCode.ERROR ? "error" : "success";
}

const milliseconds = ([seconds, nanos]: readonly [number, number]) => seconds * 1000 + nanos / 1e6;

/** Native OMP spans and run summaries, exported into our local event timeline. */
export class ShioriTelemetry {
  readonly config: AgentTelemetryConfig;
  private readonly provider: BasicTracerProvider;
  private readonly spans = new Map<string, EventTrace>();
  private run: EventTrace = {};

  constructor(log: EventLog, context: () => EventTrace,
    onStart: (event: TelemetryHookContext, trace: EventTrace) => void = () => {},
  ) {
    const record = log.recorder(SHIORI_SOURCE);
    this.provider = new BasicTracerProvider({
      // An explicit local provider gives native spans real IDs even when the
      // application has no global OTel SDK. No exporter, global registration or
      // context-manager replacement is needed: OMP passes its parents explicitly.
      sampler: new AlwaysOnSampler(),
      spanProcessors: [{
        onStart() {}, forceFlush: async () => {}, shutdown: async () => {},
        onEnd: (span) => {
          const id = span.spanContext().spanId;
          const trace = this.spans.get(id);
          // The SDK processor runs after OMP has set its final status. OMP's
          // onSpanEnd hook runs before that for tools and uncaught run errors.
          record("shiori_span_end", { name: span.name, operation: span.attributes["gen_ai.operation.name"],
            attributes: span.attributes, status: span.status, outcome: outcome(span), events: span.events,
            durationMs: milliseconds(span.duration), startedAt: new Date(milliseconds(span.startTime)).toISOString(),
            endedAt: new Date(milliseconds(span.endTime)).toISOString() }, trace);
          this.spans.delete(id);
        },
      }],
    });
    this.config = {
      tracer: this.provider.getTracer("ludens.shiori.omp", SHIORI_SOURCE.implementationVersion),
      agent: { name: "shiori" },
      // Bodies already have shared archive references. Do not capture another
      // prompt/response/tool-result copy in native telemetry attributes.
      captureMessageContent: "none",
      onSpanStart: (event) => {
        const span = event.span as typeof event.span & ReadableSpan;
        const identity = span.spanContext();
        const trace: EventTrace = { epoch: context().epoch, traceId: identity.traceId, spanId: identity.spanId,
          parentSpanId: span.parentSpanContext?.spanId, toolCallId: event.toolCallId };
        this.spans.set(identity.spanId, trace);
        if (event.kind === "invoke_agent") this.run = trace;
        record("shiori_span_start", { name: span.name, operation: event.kind, attributes: span.attributes,
          conversationId: event.conversationId, stepNumber: event.stepNumber, toolName: event.toolName }, trace);
        onStart(event, trace);
      },
      // This is one native agentLoop invocation, not an RSA takeover epoch.
      onRunEnd: (summary, coverage) => record("shiori_run_end", { scope: "agent_loop", summary, coverage }, this.run),
      onTelemetryWarning: (warning) => record("shiori_telemetry_warning", {
        code: warning.code, message: warning.message,
        error: warning.error === undefined ? undefined : String(warning.error),
      }, { epoch: context().epoch }),
    };
  }

  close() { return this.provider.shutdown(); }
}
