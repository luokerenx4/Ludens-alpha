import type { Capabilities, ExecutionResult, Observation, ObservationRequest } from "../contracts.ts";
import type { EventTrace, RecordEvent } from "./events.ts";

export interface Driver {
  run(context: { epoch: string; signal: AbortSignal; message?: string }): Promise<void>;
  consolidate(context: { epoch: string; signal: AbortSignal }): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export type ObservationOrigin = "cli" | "explicit" | "prompt_start" | "tool_batch";

export class Runtime {
  private epoch = "";
  private mode: "manual" | "acquiring" | "auto" | "releasing" = "manual";
  private control?: AbortController;
  private opening?: Promise<void>;
  private stopping?: Promise<void>;
  private running?: Promise<void>;
  private aborting?: Promise<void>;
  private consolidating = false;
  private acquired: Capabilities["controllers"] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private takeoverDeadlineMs = 0;
  private reason = "startup";
  private connected = true;
  private lastExecution?: { result: ExecutionResult; trace: EventTrace };
  private previousObservations = new Map<string, Observation>();
  driver?: Driver;

  constructor(readonly capabilities: Capabilities, readonly record: RecordEvent, private maxSeconds = 300, private runId: string = crypto.randomUUID()) {}

  status() {
    // The host can outlive many takeovers; its log clock is not this cycle's budget.
    const remainingSeconds = this.mode === "auto" ? Math.max(0, Math.ceil((this.takeoverDeadlineMs - performance.now()) / 1000)) : null;
    return { runId: this.runId, maxSeconds: this.maxSeconds, remainingSeconds, mode: this.mode, epoch: this.mode === "auto" ? this.epoch : null, connected: this.connected, reason: this.reason, agent: !!this.driver, thinking: !!this.running, consolidating: this.consolidating };
  }

  list() {
    return {
      sensors: this.capabilities.sensors.map((s) => ({ id: s.id, mediaTypes: s.mediaTypes })),
      controllers: this.capabilities.controllers.map((c) => ({ id: c.id })),
    };
  }

  async start(message?: string) {
    if (this.mode !== "manual" || this.running) throw new Error("Previous control cycle has not finished");
    if (!this.connected) throw new Error("Provider disconnected; restart the application");
    const epoch = this.epoch = crypto.randomUUID();
    this.lastExecution = undefined;
    const control = this.control = new AbortController();
    this.mode = "acquiring";
    this.opening = (async () => {
      for (const controller of this.capabilities.controllers) {
        await controller.acquire(epoch);
        this.acquired.push(controller);
        if (control.signal.aborted) return;
      }
    })();
    try { await this.opening; }
    catch (error) { await this.stop(String(error)); throw error; }
    if (control.signal.aborted) return this.status();
    this.takeoverDeadlineMs = performance.now() + this.maxSeconds * 1000;
    this.mode = "auto";
    this.reason = "enabled";
    this.record("control", this.status(), { epoch });
    if (message) this.record("user_message", { text: message }, { epoch });
    this.timer = setTimeout(() => void this.stop("time budget").catch((e) => this.record("error", String(e))), this.maxSeconds * 1000);
    if (this.driver) {
      this.running = this.driver.run({ epoch, signal: control.signal, message })
        .catch((error) => { if (!control.signal.aborted) this.record("error", String(error)); })
        .finally(async () => {
          await this.stop("agent ended");
          await this.aborting;
          this.running = undefined;
        });
    }
    return this.status();
  }

  async consolidate(seconds = 600) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("--seconds must be positive and within the timer range");
    if (this.mode !== "manual" || this.running) throw new Error("Previous control cycle has not finished");
    if (!this.driver) throw new Error("Consolidation requires an agent");
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.consolidating = true;
    this.reason = "consolidating";
    this.record("consolidation_start", { seconds }, { epoch });
    this.timer = setTimeout(() => void this.stop("consolidation time budget"), seconds * 1000);
    let outcome = "completed";
    this.running = this.driver.consolidate({ epoch, signal: control.signal })
      .catch((error) => {
        outcome = "failed";
        if (!control.signal.aborted) this.record("error", String(error), { epoch });
      })
      .finally(async () => {
        clearTimeout(this.timer);
        await this.aborting;
        if (control.signal.aborted) outcome = "aborted";
        this.consolidating = false;
        this.running = undefined;
        if (!control.signal.aborted) this.reason = `consolidation ${outcome}`;
        this.record("consolidation_end", { outcome, reason: this.reason }, { epoch });
      });
    return { ...this.status(), consolidationId: epoch };
  }

  private abortDriver() {
    this.aborting = this.driver?.abort().catch((e) => this.record("error", String(e)));
  }

  async stop(reason = "human") {
    if (this.stopping) return this.stopping;
    if (this.mode === "manual") {
      if (this.consolidating && !this.control?.signal.aborted) {
        this.reason = reason;
        this.control?.abort();
        clearTimeout(this.timer);
        this.abortDriver();
      }
      return;
    }
    this.mode = "releasing";
    this.reason = reason;
    this.control?.abort();
    clearTimeout(this.timer);
    // Revoking the device never waits for model cancellation.
    this.abortDriver();
    this.stopping = (async () => {
      await this.opening?.catch(() => {});
      const outcomes = await Promise.allSettled(this.acquired.map((c) => c.release(this.epoch)));
      this.acquired = [];
      const failure = outcomes.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") {
        this.connected = false;
        this.record("error", String(failure.reason));
      }
      this.mode = "manual";
      this.record("control", this.status(), { epoch: this.epoch });
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async disconnected(error: Error) {
    this.connected = false;
    await this.stop(error.message);
    this.record("disconnected", error.message);
  }

  private sensor(id: string) {
    const sensor = this.capabilities.sensors.find((s) => s.id === id);
    if (!sensor) throw new Error(`Unknown sensor: ${id}`);
    return sensor;
  }

  help(kind: string, id: string) {
    if (kind === "sensor") return this.sensor(id).help();
    const controller = this.capabilities.controllers.find((c) => c.id === id);
    if (!controller) throw new Error(`Unknown controller: ${id}`);
    return controller.help();
  }

  async observe(request: ObservationRequest, signal: AbortSignal, parent: EventTrace = {}, origin: ObservationOrigin = "cli"): Promise<Observation[]> {
    const trace = { ...parent, operationId: crypto.randomUUID() };
    // Snapshot at request time: a concurrent command completing during capture
    // must not be mistaken for an action that preceded this sample.
    const execution = this.lastExecution;
    this.record("observation_start", { ...request, origin }, trace);
    try {
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
            ? observation.sourceSequence - previous.sourceSequence : undefined,
        }, trace);
        this.previousObservations.set(key, observation);
      }
      this.record("observation_end", { observations: observations.map((o) => o.id) }, trace);
      return observations;
    } catch (error) {
      this.record("observation_error", { error: String(error), aborted: signal.aborted }, trace);
      throw error;
    }
  }

  async execute(id: string, argv: string[], epoch: string, signal?: AbortSignal, parent: EventTrace = {}) {
    const trace = { ...parent, epoch, operationId: crypto.randomUUID() };
    this.record("command", { id, argv, epoch }, trace);
    try {
      if (this.mode !== "auto" || epoch !== this.epoch) throw new Error("STALE_EPOCH: acquire control and use its original RSA_EPOCH");
      const controller = this.capabilities.controllers.find((c) => c.id === id);
      if (!controller) throw new Error(`Unknown controller: ${id}`);
      const combined = signal ? AbortSignal.any([signal, this.control!.signal]) : this.control!.signal;
      const result = await controller.execute(argv, { epoch, signal: combined });
      this.lastExecution = { result, trace };
      this.record("execution", result, trace);
      return result;
    } catch (error) {
      this.record("execution_error", { error: String(error), aborted: signal?.aborted || this.control?.signal.aborted || false }, trace);
      throw error;
    }
  }

  async close() {
    await this.stop("shutdown");
    await this.running;
    await this.driver?.close();
  }
}
