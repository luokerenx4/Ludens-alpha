import { randomBytes } from "node:crypto";
import type { Capabilities, ExecutionResult, Observation } from "./contracts.ts";
import type { Catalog, DeviceEvent, RecordEvent, Request, Trace } from "./protocol.ts";

export interface DriverInfo { id: string; version: string }
export interface ClientContext { id: string; onEvent?(event: DeviceEvent): void }

function operationTrace(parent: Trace, operationId: string): Trace {
  return { ...parent, operationId, traceId: parent.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"), parentSpanId: parent.spanId };
}

/** Device ownership and observations, independent of agents and their workspaces. */
export class BasewareCore {
  readonly capabilities: Capabilities;
  readonly serviceId: string;
  private drivers: DriverInfo[];
  private sink: RecordEvent;
  private clients = new Map<string, ClientContext>();
  private owner?: ClientContext;
  private epoch?: string;
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

  constructor(options: { capabilities: Capabilities; drivers: DriverInfo[]; record?: RecordEvent; serviceId?: string }) {
    this.capabilities = options.capabilities;
    this.drivers = options.drivers;
    this.sink = options.record ?? (() => {});
    this.serviceId = options.serviceId ?? crypto.randomUUID();
    for (const group of [options.drivers, options.capabilities.controllers]) {
      const ids = new Set<string>();
      for (const item of group) {
        if (ids.has(item.id)) throw new Error(`Duplicate capability or driver ID: ${item.id}`);
        ids.add(item.id);
      }
    }
  }

  readonly record: RecordEvent = (type, data, trace = {}) => {
    const seq = ++this.sequence;
    const metadata = { source: { component: "baseware", implementation: "baseware" },
      origin: { eventId: `${this.serviceId}:${seq}`, clockId: this.serviceId, seq,
        at: new Date().toISOString(), atMs: performance.now() } };
    this.sink(type, data, trace, metadata);
    const recipients = new Map(this.clients);
    if (this.owner) recipients.set(this.owner.id, this.owner);
    for (const client of recipients.values()) client.onEvent?.({ type, data, trace, ...metadata });
  };

  status() {
    return { serviceId: this.serviceId, mode: this.mode, epoch: this.mode === "auto" ? this.epoch ?? null : null,
      connected: this.connected, reason: this.reason,
      remainingSeconds: this.mode === "auto" ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : null };
  }

  list(): Catalog {
    return { drivers: this.drivers,
      controllers: this.capabilities.controllers.map(c => ({ id: c.id, requiresControl: c.requiresControl,
        ...(c.mediaTypes ? { mediaTypes: c.mediaTypes } : {}), help: c.help() })) };
  }

  private controller(id: string) {
    const controller = this.capabilities.controllers.find(c => c.id === id);
    if (!controller) throw new Error(`Unknown controller: ${id}`);
    return controller;
  }

  help(id: string) { return this.controller(id).help(); }

  async acquire(epoch: string, seconds: number, client: ClientContext, signal?: AbortSignal) {
    if (!epoch?.trim()) throw new Error("acquire requires an epoch");
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("seconds must be positive and within the timer range");
    if (this.mode !== "manual") throw new Error("Device control is already owned or changing");
    if (!this.connected) throw new Error("Driver disconnected; restart Baseware");
    signal?.throwIfAborted();
    this.epoch = epoch;
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
    this.record("baseware_control", this.status(), { epoch });
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
        this.record("error", String(outcome.reason), { epoch: this.epoch });
      }
      this.mode = "manual";
      const status = this.status();
      this.record("baseware_control", status, { epoch: this.epoch });
      this.owner = undefined;
      return status;
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async disconnectClient(id: string) {
    this.clients.delete(id);
    if (this.owner?.id === id) await this.release(this.epoch, "owner disconnected");
  }

  async disconnected(error: Error) {
    this.connected = false;
    this.record("baseware_disconnected", error.message, { epoch: this.epoch });
    await this.release(this.epoch, error.message);
  }

  private recordObservations(observations: Observation[], argv: string[], trace: Trace, origin: string, execution: typeof this.lastExecution) {
    for (const observation of observations) {
      const key = JSON.stringify([observation.controllerId, argv]);
      const previous = this.previousObservations.get(key);
      const sameClock = previous?.timing.clock === observation.timing.clock;
      const afterExecution = execution?.result.timing.clock === observation.timing.clock ? {
        id: execution.result.id, toolCallId: execution.trace.toolCallId,
        operationId: execution.trace.operationId, status: execution.result.status,
        completedAtMs: execution.result.timing.receivedAtMs,
        captureRequestedAfterMs: observation.timing.requestedAtMs - execution.result.timing.receivedAtMs,
        captureReceivedAfterMs: observation.timing.receivedAtMs - execution.result.timing.receivedAtMs,
      } : undefined;
      this.record("observation", { ...observation, origin, afterExecution,
        previousObservationId: sameClock ? previous.id : undefined,
        sourceSequenceDelta: sameClock && previous.sourceSequence !== undefined && observation.sourceSequence !== undefined
          ? observation.sourceSequence - previous.sourceSequence : undefined }, trace);
      this.previousObservations.set(key, observation);
    }
  }

  async execute(id: string, argv: string[], epoch: string | undefined, signal: AbortSignal, parent: Trace = {}, operationId: string = crypto.randomUUID(), origin = "cli") {
    const trace = operationTrace({ ...parent, ...(epoch ? { epoch } : {}) }, operationId);
    const controller = this.capabilities.controllers.find(c => c.id === id);
    const previousExecution = this.lastExecution;
    const operation = { controllerId: id, argv, epoch, requiresControl: controller?.requiresControl, origin };
    this.record("command", operation, trace);
    let observing = Boolean(controller?.mediaTypes?.length);
    if (observing) this.record("observation_start", operation, trace);
    let combined = signal;
    try {
      if (!controller) throw new Error(`Unknown controller: ${id}`);
      if (controller.requiresControl) {
        if (this.mode !== "auto" || !epoch || epoch !== this.epoch) throw new Error("STALE_EPOCH: acquire control and use its original epoch");
        combined = AbortSignal.any([signal, this.control!.signal]);
      }
      combined.throwIfAborted();
      const result = await controller.execute(argv, { epoch, signal: combined });
      // Read-only calls must not displace the last action; revoked calls cannot attach to a new owner.
      if (controller.requiresControl && epoch === this.epoch) this.lastExecution = { result, trace };
      const outcome = combined.aborted || result.status === "interrupted" ? "cancelled"
        : result.status === "completed" && result.exitCode === 0 ? "success" : "error";
      this.record("execution", { ...result, controllerId: id, requiresControl: controller.requiresControl, outcome }, trace);
      if (result.observations?.length && !observing) {
        observing = true;
        this.record("observation_start", operation, trace);
      }
      if (observing) {
        this.recordObservations(result.observations ?? [], argv, trace, origin,
          controller.requiresControl ? { result, trace } : previousExecution);
        this.record("observation_end", { controllerId: id, observations: result.observations?.map(o => o.id) ?? [], outcome }, trace);
      }
      return result;
    } catch (error) {
      const aborted = combined.aborted;
      const data = { controllerId: id, requiresControl: controller?.requiresControl, error: String(error), aborted,
        outcome: aborted ? "cancelled" : "error" };
      this.record("execution_error", data, trace);
      if (observing) this.record("observation_error", data, trace);
      throw error;
    }
  }

  async handle(request: Request, client: ClientContext, signal = new AbortController().signal): Promise<unknown> {
    let deviceOperation = false;
    try {
      const argv = request.argv ?? [];
      if (!Array.isArray(argv) || argv.some(arg => typeof arg !== "string")) throw new Error("argv must be strings");
      switch (request.kind) {
        case "status": return this.status();
        case "list": return this.list();
        case "subscribe": this.clients.set(client.id, client); return this.status();
        case "help": if (!request.id) throw new Error("Missing capability ID"); return this.help(request.id);
        case "acquire": return await this.acquire(request.epoch!, request.seconds!, client, signal);
        case "release": if (!request.epoch) throw new Error("release requires an epoch"); return await this.release(request.epoch);
        case "revoke": return await this.release(undefined, "human");
        case "controller":
          if (!request.id) throw new Error("Missing controller ID");
          deviceOperation = true;
          return await this.execute(request.id, argv, request.epoch, signal, request.trace, request.operationId, request.origin);
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

  async close() { await this.release(undefined, "shutdown"); }
}
