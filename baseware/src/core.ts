import type { Capabilities, ExecutionResult, Observation, ObservationRequest } from "./contracts.ts";
import type { DeviceEvent, RecordEvent, Request, Trace } from "./protocol.ts";

export interface DriverInfo { id: string; version: string }
export interface ClientContext { id: string; onEvent?(event: DeviceEvent): void }

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

  constructor(options: { capabilities: Capabilities; drivers: DriverInfo[]; record?: RecordEvent; serviceId?: string }) {
    this.capabilities = options.capabilities;
    this.drivers = options.drivers;
    this.sink = options.record ?? (() => {});
    this.serviceId = options.serviceId ?? crypto.randomUUID();
    for (const group of [options.drivers, options.capabilities.sensors, options.capabilities.controllers]) {
      const ids = new Set<string>();
      for (const item of group) {
        if (ids.has(item.id)) throw new Error(`Duplicate capability or driver ID: ${item.id}`);
        ids.add(item.id);
      }
    }
  }

  readonly record: RecordEvent = (type, data, trace = {}) => {
    this.sink(type, data, trace);
    const recipients = new Map(this.clients);
    if (this.owner) recipients.set(this.owner.id, this.owner);
    for (const client of recipients.values()) client.onEvent?.({ type, data, trace });
  };

  status() {
    return { serviceId: this.serviceId, mode: this.mode, epoch: this.mode === "auto" ? this.epoch ?? null : null,
      connected: this.connected, reason: this.reason,
      remainingSeconds: this.mode === "auto" ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : null };
  }

  list() {
    return { drivers: this.drivers,
      sensors: this.capabilities.sensors.map(s => ({ id: s.id, mediaTypes: s.mediaTypes, help: s.help() })),
      controllers: this.capabilities.controllers.map(c => ({ id: c.id, help: c.help() })) };
  }

  private sensor(id: string) {
    const sensor = this.capabilities.sensors.find(s => s.id === id);
    if (!sensor) throw new Error(`Unknown sensor: ${id}`);
    return sensor;
  }

  help(id: string, kind?: string) {
    if (kind === "sensor") return this.sensor(id).help();
    const controller = this.capabilities.controllers.find(c => c.id === id);
    if (controller && kind !== "sensor") return controller.help();
    return this.sensor(id).help();
  }

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
      for (const controller of this.capabilities.controllers) {
        await controller.acquire(epoch);
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
      const outcomes = await Promise.allSettled(this.acquired.map(c => c.release(this.epoch!)));
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

  async observe(request: ObservationRequest, signal: AbortSignal, parent: Trace = {}, origin = "cli", operationId: string = crypto.randomUUID()) {
    const trace = { ...parent, operationId };
    const execution = this.lastExecution;
    this.record("observation_start", { ...request, origin }, trace);
    try {
      signal.throwIfAborted();
      const observations = await this.sensor(request.sensorId).read(request.argv, signal);
      for (const observation of observations) {
        const key = JSON.stringify([observation.sensorId, request.argv]);
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
      this.record("observation_end", { observations: observations.map(o => o.id) }, trace);
      return observations;
    } catch (error) {
      this.record("observation_error", { error: String(error), aborted: signal.aborted }, trace);
      throw error;
    }
  }

  async execute(id: string, argv: string[], epoch: string | undefined, signal: AbortSignal, parent: Trace = {}, operationId: string = crypto.randomUUID()) {
    const trace = { ...parent, epoch, operationId };
    this.record("command", { id, argv, epoch }, trace);
    try {
      if (this.mode !== "auto" || !epoch || epoch !== this.epoch) throw new Error("STALE_EPOCH: acquire control and use its original epoch");
      const controller = this.capabilities.controllers.find(c => c.id === id);
      if (!controller) throw new Error(`Unknown controller: ${id}`);
      const combined = AbortSignal.any([signal, this.control!.signal]);
      combined.throwIfAborted();
      const result = await controller.execute(argv, { epoch, signal: combined });
      // A revoked operation may settle after a new owner acquired the device.
      if (epoch === this.epoch) this.lastExecution = { result, trace };
      this.record("execution", result, trace);
      return result;
    } catch (error) {
      this.record("execution_error", { error: String(error), aborted: signal.aborted || this.control?.signal.aborted || false }, trace);
      throw error;
    }
  }

  async handle(request: Request, client: ClientContext, signal = new AbortController().signal): Promise<unknown> {
    const argv = request.argv ?? [];
    if (!Array.isArray(argv) || argv.some(arg => typeof arg !== "string")) throw new Error("argv must be strings");
    switch (request.kind) {
      case "status": return this.status();
      case "list": return this.list();
      case "subscribe": this.clients.set(client.id, client); return this.status();
      case "help": if (!request.id) throw new Error("Missing capability ID"); return this.help(request.id, argv[0]);
      case "acquire": return await this.acquire(request.epoch!, request.seconds!, client, signal);
      case "release": if (!request.epoch) throw new Error("release requires an epoch"); return await this.release(request.epoch);
      case "revoke": return await this.release(undefined, "human");
      case "sensor":
        if (!request.id) throw new Error("Missing sensor ID");
        return await this.observe({ sensorId: request.id, argv }, signal,
          { ...request.trace, ...(request.epoch ? { epoch: request.epoch } : {}) }, request.origin, request.operationId);
      case "controller":
        if (!request.id) throw new Error("Missing controller ID");
        return await this.execute(request.id, argv, request.epoch, signal, request.trace, request.operationId);
      default: throw new Error(`Unknown request kind: ${request.kind}`);
    }
  }

  async close() { await this.release(undefined, "shutdown"); }
}
