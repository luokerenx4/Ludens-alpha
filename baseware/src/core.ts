import { randomBytes } from "node:crypto";
import type { Capabilities, ExecutionResult, Observation, ToolArguments } from "./contracts.ts";
import { argumentValidator, archivedToolResult, observationMetadata } from "./tool-contract.ts";
import type { Catalog, DeviceEvent, EventMetadata, RecordEvent, Request, Trace } from "./protocol.ts";
import type { DriverManifest } from "./drivers/registry.ts";
import type { EventSourceDescriptor } from "../../shared/event-sources.ts";
import { SamplingStats } from "./sampling-stats.ts";

export type DriverInfo = Pick<DriverManifest, "id" | "transport" | "defaultPort" | "needsGame" | "launchHint" | "launchCommand"> & { version: string };
export interface ClientContext { id: string; onEvent?(event: DeviceEvent): void }

function operationTrace(parent: Trace, operationId: string): Trace {
  return { ...parent, operationId, traceId: parent.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"), parentSpanId: parent.spanId };
}

/** Device ownership and observations, independent of agents and their workspaces. */
export class BasewareCore {
  readonly capabilities: Capabilities;
  readonly serviceId: string;
  readonly source?: EventSourceDescriptor;
  readonly diagnostics: "normal" | "full";
  private drivers: DriverInfo[];
  private sink: RecordEvent;
  private clients = new Map<string, ClientContext>();
  private owner?: ClientContext;
  private epoch?: string;
  private controlTrace: Trace = {};
  private mode: "manual" | "acquiring" | "auto" | "releasing" = "manual";
  private connected = true;
  private reason = "startup";
  private control?: AbortController;
  private opening?: Promise<void>;
  private stopping?: Promise<ReturnType<BasewareCore["status"]>>;
  private acquired: Capabilities["controllers"] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private lastExecution?: { result: ExecutionResult; trace: Trace };
  private previousObservations = new Map<string, Observation>();
  private sequence = 0;
  private validators = new Map<string, (value: unknown) => ToolArguments>();
  private sampling: SamplingStats;
  private statsTimer: ReturnType<typeof setInterval>;
  private logFailure?: { firstSeq: number; lastSeq: number; count: number; error: string };

  constructor(options: { capabilities: Capabilities; drivers: DriverInfo[]; record?: RecordEvent; serviceId?: string;
    source?: EventSourceDescriptor; diagnostics?: "normal" | "full" }) {
    this.capabilities = options.capabilities;
    this.drivers = options.drivers;
    this.sink = options.record ?? (() => {});
    this.serviceId = options.serviceId ?? crypto.randomUUID();
    this.source = options.source;
    this.diagnostics = options.diagnostics ?? "normal";
    if (this.source && this.source.sourceId !== this.serviceId) throw new Error("Event source identity mismatch");
    for (const ids of [options.drivers.map(d => d.id), options.capabilities.controllers.map(c => c.tool.name)]) {
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate capability or driver ID");
    }
    for (const controller of this.capabilities.controllers) this.validators.set(controller.tool.name, argumentValidator(controller.tool));
    this.sampling = new SamplingStats(this.record);
    this.statsTimer = setInterval(() => this.sampling.flush(), this.sampling.periodMs);
    this.statsTimer.unref();
  }

  readonly record: RecordEvent = (type, data, trace = {}, options = {}) => {
    const seq = ++this.sequence;
    const metadata: Required<Pick<EventMetadata, "source" | "origin">> & EventMetadata = {
      source: { component: "baseware", implementation: "baseware" },
      origin: { eventId: `${this.serviceId}:${seq}`, clockId: this.serviceId, seq,
        at: new Date().toISOString(), atMs: performance.now() }, ...(options.channel ? { channel: options.channel } : {}) };
    let recovered: typeof this.logFailure;
    try {
      this.sink(type, data, trace, metadata);
      recovered = this.logFailure;
      this.logFailure = undefined;
    } catch (error) {
      metadata.persisted = false;
      if (!this.logFailure) {
        this.logFailure = { firstSeq: seq, lastSeq: seq, count: 0, error: String(error) };
        console.error(`Baseware event storage unavailable: ${String(error)}`);
      }
      this.logFailure.lastSeq = seq; this.logFailure.count++; this.logFailure.error = String(error);
    }
    const recipients = new Map(this.clients);
    if (this.owner) recipients.set(this.owner.id, this.owner);
    for (const client of recipients.values()) {
      // Telemetry and subscribers must never turn a completed input into a retryable failure.
      try { client.onEvent?.({ type, data, trace, ...metadata }); } catch { /* client owns its transport */ }
    }
    if (recovered) this.record("event_storage_gap", recovered, trace);
  };

  status() {
    return { serviceId: this.serviceId, source: this.source, seq: this.sequence, diagnostics: this.diagnostics,
      storageError: this.logFailure ?? null, mode: this.mode, epoch: this.mode === "auto" ? this.epoch ?? null : null,
      connected: this.connected, reason: this.reason,
      remainingSeconds: this.mode === "auto" ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : null };
  }

  list(): Catalog {
    return { drivers: this.drivers,
      controllers: this.capabilities.controllers.map(c => ({ ...c.tool, requiresControl: c.requiresControl,
        ...(c.mediaTypes ? { mediaTypes: c.mediaTypes } : {}) })) };
  }

  help(id: string) {
    const tool = this.list().controllers.find(c => c.name === id);
    if (!tool) throw new Error(`Unknown controller: ${id}`);
    return tool;
  }

  async acquire(epoch: string, seconds: number, client: ClientContext, signal?: AbortSignal, trace: Trace = {}) {
    if (!epoch?.trim()) throw new Error("acquire requires an epoch");
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("seconds must be positive and within the timer range");
    if (this.mode !== "manual") throw new Error("Device control is already owned or changing");
    if (!this.connected) throw new Error("Driver disconnected; restart Baseware");
    signal?.throwIfAborted();
    this.epoch = epoch;
    this.controlTrace = { ...trace, epoch };
    this.owner = client;
    this.lastExecution = undefined;
    this.control = new AbortController();
    const control = this.control;
    this.mode = "acquiring";
    const cancel = () => { void this.release(epoch, "acquire cancelled"); };
    signal?.addEventListener("abort", cancel, { once: true });
    this.opening = (async () => {
      for (const controller of this.capabilities.controllers.filter(c => c.requiresControl)) {
        await controller.acquire?.(epoch);
        this.acquired.push(controller);
        if (control.signal.aborted) return;
      }
    })();
    try { await this.opening; }
    catch (error) { await this.release(epoch, String(error)); throw error; }
    finally { signal?.removeEventListener("abort", cancel); }
    if (control.signal.aborted) return this.status();
    this.deadline = performance.now() + seconds * 1000;
    this.mode = "auto";
    this.reason = "acquired";
    this.timer = setTimeout(() => { void this.release(epoch, "lease expired"); }, seconds * 1000);
    this.record("baseware_control", this.status(), this.controlTrace);
    return this.status();
  }

  async release(epoch?: string, reason = "released") {
    if (epoch !== undefined && this.epoch !== undefined && epoch !== this.epoch) throw new Error("STALE_EPOCH");
    if (this.stopping) return this.stopping;
    if (this.mode === "manual") return this.status();
    this.mode = "releasing";
    this.reason = reason;
    this.control?.abort();
    clearTimeout(this.timer);
    this.stopping = (async () => {
      // Acquisition may finish after revocation. Release whatever it actually acquired.
      await this.opening?.catch(() => {});
      const outcomes = await Promise.allSettled(this.acquired.map(c => c.release?.(this.epoch!)));
      this.acquired = [];
      for (const outcome of outcomes) if (outcome.status === "rejected") {
        this.connected = false;
        this.record("error", String(outcome.reason), this.controlTrace);
      }
      this.mode = "manual";
      const status = this.status();
      this.record("baseware_control", status, this.controlTrace);
      if (this.controlTrace.recordingId) this.sampling.flush(true, this.controlTrace.recordingId);
      this.owner = undefined;
      return this.status();
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async disconnectClient(id: string) {
    this.clients.delete(id);
    if (this.owner?.id === id) await this.release(this.epoch, "owner disconnected");
  }

  async disconnected(error: Error) {
    this.connected = false;
    this.record("baseware_disconnected", error.message, this.controlTrace);
    await this.release(this.epoch, error.message);
  }

  private observationDetails(observations: Observation[], args: ToolArguments, origin: string, execution: typeof this.lastExecution) {
    return observations.map(observation => {
      const key = JSON.stringify([observation.controllerId, args]);
      const previous = this.previousObservations.get(key);
      const sameClock = previous?.timing.clock === observation.timing.clock;
      const afterExecution = execution?.result.timing.clock === observation.timing.clock ? {
        id: execution.result.id, toolCallId: execution.trace.toolCallId,
        operationId: execution.trace.operationId, status: execution.result.status,
        completedAtMs: execution.result.timing.receivedAtMs,
        captureRequestedAfterMs: observation.timing.requestedAtMs - execution.result.timing.receivedAtMs,
        captureReceivedAfterMs: observation.timing.receivedAtMs - execution.result.timing.receivedAtMs,
      } : undefined;
      const details = { ...observationMetadata(observation), origin, afterExecution,
        previousObservationId: sameClock ? previous.id : undefined,
        sourceSequenceDelta: sameClock && previous.sourceSequence !== undefined && observation.sourceSequence !== undefined
          ? observation.sourceSequence - previous.sourceSequence : undefined };
      this.previousObservations.set(key, observationMetadata(observation));
      // Diagnostics may use varied arguments; retain only a small recent correlation cache.
      if (this.previousObservations.size > 256) this.previousObservations.delete(this.previousObservations.keys().next().value!);
      return details;
    });
  }

  async execute(id: string, args: ToolArguments, epoch: string | undefined, signal: AbortSignal, parent: Trace = {}, operationId: string = crypto.randomUUID(), origin = "cli") {
    const trace = operationTrace({ ...parent, ...(epoch ? { epoch } : {}) }, operationId);
    const controller = this.capabilities.controllers.find(c => c.tool.name === id);
    const readOnly = controller?.tool.annotations?.readOnlyHint === true;
    const continuous = trace.recordingPurpose === "continuous-perception";
    if (continuous && this.diagnostics === "normal" && trace.parentSpanId) trace.parentOmitted = true;
    const metadata: EventMetadata = readOnly ? { channel: "diagnostic" } : {};
    const detailed = !readOnly || this.diagnostics === "full";
    const previousExecution = this.lastExecution;
    const operation = { controllerId: id, arguments: args, epoch, requiresControl: controller?.requiresControl, readOnly, origin };
    if (detailed) this.record("command", operation, trace, metadata);
    const startedAtMs = performance.now();
    let combined = signal;
    try {
      if (!controller) throw new Error(`Unknown controller: ${id}`);
      if (controller.requiresControl) {
        if (this.mode !== "auto" || !epoch || epoch !== this.epoch) throw new Error("STALE_EPOCH: acquire control and use its original epoch");
        combined = AbortSignal.any([signal, this.control!.signal]);
      }
      combined.throwIfAborted();
      const result = await controller.execute(this.validators.get(id)!(args), { epoch, signal: combined,
        controlSignal: controller.requiresControl ? this.control!.signal : undefined,
        record: (type, data) => {
          const outcome = data.status === "interrupted" ? "cancelled" : data.status === "failed" ? "error" : "success";
          if (type === "action_end" && epoch === this.epoch) {
            this.lastExecution = { result: data as unknown as ExecutionResult, trace };
          }
          this.record(type, { ...data, controllerId: id, requiresControl: controller.requiresControl,
            ...(type === "action_end" ? { outcome } : {}) }, trace);
        } });
      // Read-only calls must not displace the last action; revoked calls cannot attach to a new owner.
      if (controller.requiresControl && !result.actionId && !result.readOnly && epoch === this.epoch) this.lastExecution = { result, trace };
      const outcome = combined.aborted || result.status === "interrupted" ? "cancelled"
        : result.status === "completed" && result.exitCode === 0 ? "success" : "error";
      if (readOnly) this.sampling.observe(id, trace, performance.now() - startedAtMs, outcome === "success" ? undefined : `${result.status}: ${result.stderr}`);
      const nativeText = result.result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      // Failures of an explicit read remain experiences; repeating sampler failures are intervals.
      if (detailed || (!continuous && outcome !== "success")) this.record("execution", {
        ...result,
        ...(nativeText && result.stdout === nativeText ? { stdout: undefined } : {}),
        ...(nativeText && result.stderr === nativeText ? { stderr: undefined } : {}),
        observations: this.observationDetails(result.observations ?? [], args, origin,
          controller.requiresControl ? { result, trace } : previousExecution),
        result: archivedToolResult(result.result, result.observations), controllerId: id, requiresControl: controller.requiresControl,
        readOnly: result.readOnly ?? readOnly, outcome,
        ...(!detailed ? { arguments: args, origin, startedAtMs } : {}),
      }, trace, !continuous && outcome !== "success" ? {} : metadata);
      return result;
    } catch (error) {
      const aborted = combined.aborted;
      if (readOnly) this.sampling.observe(id, trace, performance.now() - startedAtMs, error);
      const data = { ...operation, startedAtMs, error: this.diagnostics === "full" && error instanceof Error ? error.stack ?? String(error) : String(error), aborted,
        outcome: aborted ? "cancelled" : "error" };
      if (detailed || !continuous) this.record("execution_error", data, trace, !continuous ? {} : metadata);
      throw error;
    }
  }

  async handle(request: Request, client: ClientContext, signal = new AbortController().signal): Promise<unknown> {
    let deviceOperation = false;
    try {
      switch (request.kind) {
        case "status": return this.status();
        case "list": return this.list();
        case "subscribe": this.clients.set(client.id, client); return this.status();
        case "help": if (!request.id) throw new Error("Missing capability ID"); return this.help(request.id);
        case "acquire": return await this.acquire(request.epoch!, request.seconds!, client, signal, request.trace);
        case "release": if (!request.epoch) throw new Error("release requires an epoch"); return await this.release(request.epoch);
        case "revoke": return await this.release(undefined, "human");
        case "controller":
          if (!request.id) throw new Error("Missing controller ID");
          deviceOperation = true;
          return await this.execute(request.id, request.arguments === undefined ? {} : request.arguments, request.epoch, signal, request.trace, request.operationId, request.origin);
        default: throw new Error(`Unknown request kind: ${request.kind}`);
      }
    } catch (error) {
      // Device operations already record their terminal event, including rejection.
      if (!deviceOperation) this.record("request_error", {
        kind: request.kind, id: request.id, error: String(error), aborted: signal.aborted,
        outcome: signal.aborted ? "cancelled" : "error",
      }, operationTrace({ ...request.trace, epoch: request.epoch }, request.operationId ?? crypto.randomUUID()));
      throw error;
    }
  }

  async close() {
    await this.release(undefined, "shutdown");
    clearInterval(this.statsTimer);
    this.sampling.flush(true);
  }
}
