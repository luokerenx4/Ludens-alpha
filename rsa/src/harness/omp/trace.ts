import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getOpenAICodexTransportDetails } from "@oh-my-pi/pi-ai/providers/openai-codex-state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ASYNC_RESULT_MESSAGE_TYPE, type AsyncResultDetails } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { LAUNCH_COMPLETION_MESSAGE_TYPE, type LaunchCompletionEntry } from "@oh-my-pi/pi-coding-agent/session/launch-completion";
import { logger } from "@oh-my-pi/pi-utils";
import { childTrace, EventLog, type EventTrace } from "../events.ts";
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

// Full job/service details are in the shared tool/custom-message artifact.
// Keep only lifecycle evidence here, not structured outputs or readiness logs.
function backgroundMetadata(value: object) {
  const fields = new Set(["jobId", "type", "status", "agentId", "label", "durationMs", "name", "id", "state", "pid",
    "createdAt", "startedAt", "readyAt", "exitedAt", "exitCode", "exitReason", "restartCount", "outputBytes", "owner", "persist", "detached"]);
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => fields.has(key)
    && ["string", "number", "boolean"].includes(typeof item)));
}

function compactionMetadata(result: CompactionResult) {
  const remote = result.preserveData?.openaiRemoteCompaction;
  const detail = remote && typeof remote === "object" ? remote as Record<string, unknown> : {};
  const usage = detail.usage && typeof detail.usage === "object" ? detail.usage as Record<string, unknown> : {};
  const counts = Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens", "reasoningOutputTokens"]
    .flatMap(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? [[key, usage[key]]] : []));
  const summary = {
    ...(Object.keys(counts).length ? { usage: counts } : {}),
    ...(typeof detail.retainedImageCount === "number" ? { retainedImageCount: detail.retainedImageCount } : {}),
  };
  return { tokensBefore: result.tokensBefore,
    ...(Object.keys(summary).length ? { preserveData: { openaiRemoteCompaction: summary } } : {}),
  };
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

// The OMP patch enters this scope at candidate creation, before its first await.
// One OMP session lives in this host; foreground work never enters this store.
const speculationChannel = channel("omp.compaction.speculation");
const speculationContext = new AsyncLocalStorage<EventTrace>();

/** Keep native compaction lifecycle events alongside the host's request timeline. */
export function installCompactionSpeculationTrace(log: EventLog, context: () => EventTrace = () => ({})) {
  const record = log.recorder(SHIORI_SOURCE);
  const operations = new Map<string, { trace: EventTrace; startedAt?: number }>();
  speculationChannel.bindStore(speculationContext, (message: unknown) => {
    const { operationId } = message as { operationId: string };
    return { ...childTrace(context()), operationId };
  });
  const stages = new Map([
    ["Speculative compaction started", "started"],
    ["Speculative compaction armed", "armed"],
    ["Speculative compaction invalidated", "invalidated"],
    ["Waiting for speculative compaction", "waiting"],
    ["Applying armed speculative compaction", "applied"],
    ["Speculative compaction failed", "failed"],
    ["Speculative compaction cancelled", "cancelled"],
  ]);
  const unsubscribe = logger.registerLogSink((event) => {
    // V2 may receive HTTP 200 and then fail inside the SSE stream. Its own
    // warning is explicit retry evidence; adjacent HTTP attempts are not.
    const retry = event.level === "warn"
      ? /^V2 compaction attempt ([1-9]\d*) failed, retrying in (\d+)ms$/.exec(event.message) : null;
    if (retry) {
      const data: Record<string, unknown> = { attempt: Number(retry[1]), retryDelayMs: Number(retry[2]) };
      for (const key of ["model", "error"]) {
        if (typeof event.context?.[key] === "string") data[key] = event.context[key];
      }
      const parent = context();
      record("compaction_retry", data, speculationContext.getStore() ?? (parent.operationId ? parent : { epoch: parent.epoch }));
      return;
    }
    const stage = stages.get(event.message);
    if (!stage) return;
    const operationId = event.context?.operationId;
    let operation = typeof operationId === "string" ? operations.get(operationId) : undefined;
    const scope = speculationContext.getStore();
    // An unknown candidate must stay unassociated, never inherit the latest epoch.
    const trace = operation?.trace ?? (typeof operationId === "string"
      ? (scope?.operationId === operationId ? scope : { operationId }) : {});
    if (stage === "started" && typeof operationId === "string" && scope?.operationId === operationId) {
      operation = { trace, startedAt: log.clock.now() };
      operations.set(operationId, operation);
    }
    const data: Record<string, unknown> = { stage };
    for (const key of ["method", "snapshotLeafId", "contextTokensAtStart", "contextTokens", "thresholdTokens", "durationMs", "tokensBefore", "reason"]) {
      const value = event.context?.[key];
      if (typeof value === "string" || typeof value === "number") data[key] = value;
    }
    if (stage === "failed" && typeof event.context?.error === "string") data.error = event.context.error;
    if (["failed", "cancelled"].includes(stage) && operation?.startedAt !== undefined)
      data.durationMs = log.clock.now() - operation.startedAt;
    record("compaction_speculation", data, trace);
    if (typeof operationId === "string" && ["applied", "invalidated", "failed", "cancelled"].includes(stage))
      operations.delete(operationId);
  });
  return () => { unsubscribe(); speculationChannel.unbindStore(speculationContext); operations.clear(); };
}

/** OMP's native compaction bypasses agent.streamFn. Observe its HTTP boundary in this dedicated host. */
export function installCompactionHttpTrace(log: EventLog, context: () => EventTrace = () => ({})) {
  const record = log.recorder(SHIORI_SOURCE);
  const original = globalThis.fetch;
  const wrapped = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const request = compactionRequest(input, init);
    if (!request) return original(...args);
    const trace = { ...childTrace(speculationContext.getStore() ?? context()), httpId: crypto.randomUUID() };
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
      body: bytes === undefined ? undefined : log.bytes(bytes, "bin", {
        contentType: request.headers.get("content-type"), contentEncoding: request.headers.get("content-encoding"),
      }),
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
  private maintenance: { trace: EventTrace; startedAt: number } | undefined;
  private readonly record: ReturnType<EventLog["recorder"]>;
  constructor(private log: EventLog, private context: () => { epoch?: string; observations?: string[]; deliveryIds?: string[]; skillVersion?: string; memoryVersion?: string }) {
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

  compactionParent = (): EventTrace => {
    if (this.maintenance) return { ...this.maintenance.trace };
    const epoch = this.context().epoch;
    // Parent to the native loop, not its most recently completed tool/chat span.
    return epoch && this.nativeRun.epoch === epoch
      ? { ...this.nativeRun, modelCallId: this.active.modelCallId }
      : { epoch };
  };

  attach(session: AgentSession) {
    const original = session.agent.streamFn;
    session.agent.streamFn = this.wrap(original);
    const disposeCompactionTrace = installCompactionSpeculationTrace(this.log, this.compactionParent);
    // A delayed native notification belongs to its launcher, even after another
    // model turn or takeover. Service names alone are reusable, so include PID.
    const background = new Map<string, EventTrace>();
    const serviceKey = (name: string, pid?: number) => JSON.stringify(["service", name, pid]);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const { args, ...metadata } = event;
        this.record("tool_start", this.log.archive && args !== undefined
          ? { ...metadata, argsRef: this.log.artifact(args) } : event, this.current(event.toolCallId));
      }
      if (event.type === "tool_execution_update") this.record("tool_update", {
        toolName: event.toolName, toolCallId: event.toolCallId, result: this.log.artifact(event.partialResult),
      }, this.current(event.toolCallId));
      if (event.type === "tool_execution_end") {
        const trace = this.current(event.toolCallId);
        const result = this.log.artifact(event.result);
        this.record("tool_end", {
          toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, result,
        }, trace);
        if (event.toolName === "bash") {
          const details = event.result?.details;
          const job = details?.async, service = details?.service;
          const key = job?.jobId ? `job:${job.jobId}` : service?.name ? serviceKey(service.name, service.pid) : undefined;
          if (key) {
            const owner = childTrace(trace);
            background.set(key, owner);
            this.record("background_start", {
              kind: job ? "job" : "service", ...(this.log.archive ? backgroundMetadata(job ?? service) : job ?? service), result,
            }, owner);
          }
        }
      }
      if (event.type === "message_end" && event.message.role === "custom") {
        const message = event.message;
        const jobs = message.customType === ASYNC_RESULT_MESSAGE_TYPE
          ? (message.details as AsyncResultDetails | undefined)?.jobs : undefined;
        const daemons = message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE
          ? (message.details as { daemons?: LaunchCompletionEntry["daemon"][] } | undefined)?.daemons : undefined;
        if (jobs?.length || daemons?.length) {
          const result = this.log.artifact(message);
          for (const job of jobs ?? []) {
            const key = `job:${job.jobId}`;
            this.record("background_result", { kind: "job", ...(this.log.archive ? backgroundMetadata(job) : job), result,
              isError: job.status === "failed" }, background.get(key) ?? {});
            background.delete(key);
          }
          for (const daemon of daemons ?? []) {
            const key = serviceKey(daemon.name, daemon.pid);
            this.record("background_result", { kind: "service", ...(this.log.archive ? backgroundMetadata(daemon) : daemon), result,
              isError: daemon.state === "failed" }, background.get(key) ?? {});
            background.delete(key);
          }
        }
      }
      if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
        if (event.type === "auto_compaction_start")
          this.maintenance = { trace: { ...childTrace(this.compactionParent()), operationId: crypto.randomUUID() }, startedAt: this.log.clock.now() };
        const data = event.type === "auto_compaction_end" && event.result && this.log.archive
          ? { ...event, result: compactionMetadata(event.result), resultRef: this.log.artifact(event.result) } : event;
        this.record(event.type, { ...data, ...(event.type === "auto_compaction_end" && this.maintenance
          ? { durationMs: this.log.clock.now() - this.maintenance.startedAt } : {}) }, this.maintenance?.trace ?? {});
        if (event.type === "auto_compaction_end") this.maintenance = undefined;
      }
    });
    return () => { unsubscribe(); disposeCompactionTrace(); background.clear(); session.agent.streamFn = original; };
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
        observations: source.observations, deliveryIds: source.deliveryIds, skillVersion: source.skillVersion, memoryVersion: source.memoryVersion, streamPath,
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
              contentEncoding: request.headers.get("content-encoding"), body: this.log.bytes(bytes, "bin", {
                contentType: request.headers.get("content-type"), contentEncoding: request.headers.get("content-encoding"),
              }) }, httpTrace);
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
                errorBody: response.ok ? undefined : this.log.bytes(new Uint8Array(await response.clone().arrayBuffer()), "bin", {
                  contentType: response.headers.get("content-type"),
                  // Fetch has already decoded response Content-Encoding.
                }),
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
