import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getOpenAICodexTransportDetails } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { EventLog, type EventTrace } from "../events.ts";
import { SHIORI_SOURCE, ShioriTelemetry } from "./shiori.ts";

// Only transport diagnostics; never copy authentication headers or stream options.
function responseHeaders(headers: Headers) {
  return Object.fromEntries(["content-type", "content-encoding", "x-request-id", "request-id", "retry-after", "server-timing", "cf-ray"]
    .flatMap((name) => { const value = headers.get(name); return value === null ? [] : [[name, value]]; }));
}

function errorCode(error: Error) {
  return "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined;
}

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return {};
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return { code: errorCode(error), cause: cause && { name: cause.name, code: errorCode(cause), message: cause.message } };
}

function compactionRequest(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : input); } catch { return; }
  if (url.origin !== "https://chatgpt.com" || !["/backend-api/codex/responses", "/backend-api/codex/responses/compact"].includes(url.pathname)) return;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  try {
    if (JSON.parse(headers.get("x-codex-turn-metadata") ?? "null")?.request_kind !== "compaction") return;
  } catch { return; }
  return { url, headers };
}

/** Keep native compaction lifecycle events alongside the host's request timeline. */
export function installCompactionSpeculationTrace(log: EventLog, context: () => EventTrace = () => ({})) {
  const record = log.recorder(SHIORI_SOURCE);
  const stages = new Map([
    ["Speculative compaction started", "started"],
    ["Speculative compaction armed", "armed"],
    ["Speculative compaction invalidated", "invalidated"],
    ["Waiting for speculative compaction", "waiting"],
    ["Applying armed speculative compaction", "applied"],
    ["Speculative compaction failed", "failed"],
  ]);
  return logger.registerLogSink((event) => {
    // V2 may receive HTTP 200 and then fail inside the SSE stream. Its own
    // warning is explicit retry evidence; adjacent HTTP attempts are not.
    const retry = event.level === "warn"
      ? /^V2 compaction attempt ([1-9]\d*) failed, retrying in (\d+)ms$/.exec(event.message) : null;
    if (retry) {
      const data: Record<string, unknown> = { attempt: Number(retry[1]), retryDelayMs: Number(retry[2]) };
      for (const key of ["model", "error"]) {
        if (typeof event.context?.[key] === "string") data[key] = event.context[key];
      }
      record("compaction_retry", data, { epoch: context().epoch });
      return;
    }
    const stage = stages.get(event.message);
    if (!stage) return;
    const data: Record<string, unknown> = { stage };
    for (const key of ["method", "snapshotLeafId", "contextTokensAtStart", "contextTokens", "thresholdTokens", "durationMs", "tokensBefore", "reason"]) {
      const value = event.context?.[key];
      if (typeof value === "string" || typeof value === "number") data[key] = value;
    }
    if (stage === "failed" && typeof event.context?.error === "string") data.error = event.context.error;
    record("compaction_speculation", data, { epoch: context().epoch });
  });
}

/** OMP's native compaction bypasses agent.streamFn. Observe its HTTP boundary in this dedicated host. */
export function installCompactionHttpTrace(log: EventLog, context: () => EventTrace = () => ({})) {
  const record = log.recorder(SHIORI_SOURCE);
  const original = globalThis.fetch;
  const wrapped = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const request = compactionRequest(input, init);
    if (!request) return original(...args);
    const trace = { ...context(), httpId: crypto.randomUUID() };
    const started = log.clock.now();
    const body = init?.body;
    // Snapshot only bodies already in memory; never open a Request/body stream.
    const bytes = typeof body === "string" ? Buffer.from(body)
      : body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    record("compaction_http_start", {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      endpoint: `${request.url.origin}${request.url.pathname}`, bodyBytes: bytes?.byteLength,
      body: bytes === undefined ? undefined : log.bytes(bytes),
      contentType: request.headers.get("content-type"), contentEncoding: request.headers.get("content-encoding"),
    }, trace);
    const dispatchAtMs = log.clock.now();
    try {
      const response = await original(...args);
      const headersAtMs = log.clock.now();
      // This is response headers, not stream completion or upload completion.
      record("compaction_http_end", { status: response.status, headers: responseHeaders(response.headers),
        durationMs: headersAtMs - started, dispatchAtMs, headersAtMs, fetchToHeadersMs: headersAtMs - dispatchAtMs }, trace);
      return response;
    } catch (error) {
      record("compaction_http_error", { error: String(error), ...errorDetails(error), aborted: signal?.aborted ?? false,
        durationMs: log.clock.now() - started, dispatchAtMs, fetchDurationMs: log.clock.now() - dispatchAtMs }, trace);
      throw error;
    }
  }, { preconnect: original.preconnect });
  globalThis.fetch = wrapped;
  return () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; };
}

/** Observe the existing OMP stream without replacing its loop or consuming its iterator. */
export class ModelTrace {
  private active: EventTrace = {};
  private tools = new Map<string, EventTrace>();
  readonly shiori: ShioriTelemetry;
  private nativeChat: EventTrace = {};
  private nativeRun: EventTrace = {};
  private readonly record: ReturnType<EventLog["recorder"]>;
  constructor(private log: EventLog, private context: () => { epoch?: string; observations?: string[]; skillVersion?: string; memoryVersion?: string }) {
    this.record = log.recorder(SHIORI_SOURCE);
    this.shiori = new ShioriTelemetry(log, context, (event, trace) => {
      if (event.kind === "invoke_agent") {
        this.active = { ...trace };
        this.nativeRun = { ...trace };
        this.nativeChat = {};
        this.tools.clear();
      } else if (event.kind === "execute_tool" && event.toolCallId) {
        // Keep the producing model/request IDs, but the native tool owns its
        // own span. Nested CLI/API calls inherit this actual execute_tool span.
        this.tools.set(event.toolCallId, { ...this.current(event.toolCallId), ...trace });
      } else if (event.kind === "chat" && this.nativeRun.spanId && trace.parentSpanId === this.nativeRun.spanId) {
        this.nativeChat = { ...trace };
      }
    });
  }

  current = (toolCallId?: string): EventTrace => {
    if (!toolCallId) return { ...this.active };
    let trace = this.tools.get(toolCallId);
    if (!trace) { trace = { ...this.active, toolCallId }; this.tools.set(toolCallId, trace); }
    return { ...trace };
  };

  attach(session: AgentSession) {
    const original = session.agent.streamFn;
    session.agent.streamFn = this.wrap(original);
    const disposeCompactionTrace = installCompactionSpeculationTrace(this.log, this.context);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") this.record("tool_start", event, this.current(event.toolCallId));
      if (event.type === "tool_execution_end") this.record("tool_end", {
        toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
        result: this.log.artifact(event.result),
      }, this.current(event.toolCallId));
      if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
        this.record(event.type, event, { epoch: this.context().epoch });
      }
    });
    return () => { unsubscribe(); disposeCompactionTrace(); session.agent.streamFn = original; };
  }

  wrap(streamFn: StreamFn): StreamFn {
    return async (model, context, options) => {
      const source = this.context();
      const trace: EventTrace = { ...this.nativeChat, epoch: source.epoch, modelCallId: crypto.randomUUID() };
      this.tools.clear();
      this.active = trace;
      const started = this.log.clock.now();
      const streamPath = `streams/${trace.modelCallId}.jsonl`;
      let requests = 0, httpAttempts = 0, frames = 0;
      let payloadCaptureMs = 0, httpInspectionMs = 0, streamLogMs = 0;
      let firstStreamAtMs: number | undefined, dispatchAtMs: number | undefined, headersAtMs: number | undefined;
      const transportDetails = () => model.api === "openai-codex-responses"
        ? getOpenAICodexTransportDetails(model as Model<"openai-codex-responses">, options) : undefined;
      this.record("model_start", { provider: model.provider, api: model.api, model: model.id,
        observations: source.observations, skillVersion: source.skillVersion, memoryVersion: source.memoryVersion, streamPath,
        transportDetails: transportDetails() }, trace);
      const finish = (message: AssistantMessage) => {
        for (const block of message.content) if (block.type === "toolCall" && !this.tools.has(block.id)) {
          this.tools.set(block.id, { ...trace, toolCallId: block.id });
        }
        this.record("model_end", { stopReason: message.stopReason, usage: message.usage,
          durationMs: this.log.clock.now() - started, providerDurationMs: message.duration,
          ttftMs: message.ttft, responseId: message.responseId, error: message.errorMessage,
          firstStreamEventMs: firstStreamAtMs === undefined ? undefined : firstStreamAtMs - started,
          afterFirstStreamMs: firstStreamAtMs === undefined ? undefined : this.log.clock.now() - firstStreamAtMs,
          payloadCaptureMs, httpInspectionMs, streamLogMs,
          requests, httpAttempts, frames, response: this.log.artifact(message), transportDetails: transportDetails() }, trace);
      };
      const fail = (error: unknown) => this.record("model_end", {
        stopReason: options?.signal?.aborted ? "aborted" : "error", error: String(error),
        durationMs: this.log.clock.now() - started, requests, httpAttempts, frames, transportDetails: transportDetails(),
      }, trace);
      try {
        const stream = await streamFn(model, context, {
          ...options,
          onPayload: async (payload, target, signal) => {
            const replacement = await options?.onPayload?.(payload, target, signal);
            const actual = replacement === undefined ? payload : replacement;
            trace.requestId = crypto.randomUUID();
            delete trace.httpId;
            dispatchAtMs = headersAtMs = undefined;
            const captureStarted = this.log.clock.now();
            const payloadRef = this.log.artifact(actual);
            const websocket = actual !== null && typeof actual === "object"
              && "type" in actual && actual.type === "response.create";
            this.record("model_request", { attempt: ++requests, payload: payloadRef,
              bodyBytes: payloadRef.bytes, transport: websocket ? "websocket" : undefined,
              incremental: websocket ? "previous_response_id" in actual && !!actual.previous_response_id : undefined,
            }, trace);
            payloadCaptureMs += this.log.clock.now() - captureStarted;
            return actual;
          },
          fetch: async (input, init) => {
            trace.httpId = crypto.randomUUID();
            const httpTrace = { ...trace };
            const start = this.log.clock.now();
            const request = new Request(input, init);
            const bytes = new Uint8Array(await request.clone().arrayBuffer());
            const url = new URL(request.url);
            this.record("model_http_start", { attempt: ++httpAttempts, method: request.method,
              endpoint: `${url.origin}${url.pathname}`, contentType: request.headers.get("content-type"),
              contentEncoding: request.headers.get("content-encoding"), body: this.log.bytes(bytes) }, httpTrace);
            const inspectionMs = this.log.clock.now() - start;
            httpInspectionMs += inspectionMs;
            this.record("model_http_dispatch", { inspectionMs, modelElapsedMs: this.log.clock.now() - started }, httpTrace);
            dispatchAtMs = this.log.clock.now();
            headersAtMs = undefined;
            try {
              const response = await (options?.fetch ?? fetch)(input, init);
              headersAtMs = this.log.clock.now();
              this.record("model_http_end", { status: response.status,
                headers: responseHeaders(response.headers), durationMs: headersAtMs - start,
                dispatchAtMs, headersAtMs, fetchToHeadersMs: headersAtMs - dispatchAtMs,
                errorBody: response.ok ? undefined : this.log.bytes(new Uint8Array(await response.clone().arrayBuffer())),
              }, httpTrace);
              return response;
            } catch (error) {
              this.record("model_http_error", { error: String(error), ...errorDetails(error),
                aborted: options?.signal?.aborted ?? false, durationMs: this.log.clock.now() - start,
                dispatchAtMs, fetchDurationMs: this.log.clock.now() - dispatchAtMs }, httpTrace);
              throw error;
            }
          },
          onResponse: async (response, target, signal) => {
            this.record("model_response", { status: response.status, providerRequestId: response.requestId,
              headers: responseHeaders(new Headers(response.headers)) }, trace);
            await options?.onResponse?.(response, target, signal);
          },
          onSseEvent: (event, target) => {
            const now = this.log.clock.now();
            // OMP also reports outbound WS frames through this hook. They are
            // request dispatch, not the server's first response event.
            if (event.raw[0]?.startsWith(": ws →")) {
              dispatchAtMs = now;
              this.record("model_ws_dispatch", { bodyBytes: Buffer.byteLength(event.data),
                modelElapsedMs: now - started }, trace);
            } else if (firstStreamAtMs === undefined) {
              firstStreamAtMs = now;
              this.record("model_stream_start", { modelElapsedMs: now - started,
                afterHeadersMs: headersAtMs === undefined ? undefined : now - headersAtMs,
                afterDispatchMs: dispatchAtMs === undefined ? undefined : now - dispatchAtMs,
              }, trace);
            }
            this.log.stream(streamPath, event, trace, SHIORI_SOURCE); frames++;
            streamLogMs += this.log.clock.now() - now;
            options?.onSseEvent?.(event, target);
          },
        });
        // result() observes completion independently; the caller keeps the original stream.
        void stream.result().then(finish, fail).catch((error) => console.error("RSA event log failed:", error));
        return stream;
      } catch (error) { fail(error); throw error; }
    };
  }
}
