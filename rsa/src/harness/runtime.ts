import type { Observation, ObservationRequest } from "@playness/baseware/contracts";
import type { Catalog } from "@playness/baseware/protocol";
import type { EventTrace, RecordEvent } from "./events.ts";

export interface AgentRunner {
  run(context: { epoch: string; signal: AbortSignal; message?: string }): Promise<void>;
  consolidate(context: { epoch: string; signal: AbortSignal }): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export type ObservationOrigin = "cli" | "explicit" | "prompt_start" | "tool_batch";

export interface DeviceSession {
  readonly catalog: Catalog;
  acquire(epoch: string): Promise<void>;
  release(epoch: string): Promise<void>;
  observe(request: ObservationRequest, signal: AbortSignal, trace: EventTrace, origin: ObservationOrigin): Promise<Observation[]>;
}

export class Runtime {
  private epoch = "";
  private mode: "manual" | "acquiring" | "auto" | "releasing" = "manual";
  private control?: AbortController;
  private opening?: Promise<void>;
  private stopping?: Promise<void>;
  private running?: Promise<void>;
  private aborting?: Promise<void>;
  private consolidating = false;
  private timer?: ReturnType<typeof setTimeout>;
  private takeoverDeadlineMs = 0;
  private reason = "startup";
  private connected = true;
  agent?: AgentRunner;

  constructor(private devices: DeviceSession, readonly record: RecordEvent, private maxSeconds = 300, private runId: string = crypto.randomUUID()) {}

  status() {
    // The host can outlive many takeovers; its log clock is not this cycle's budget.
    const remainingSeconds = this.mode === "auto" ? Math.max(0, Math.ceil((this.takeoverDeadlineMs - performance.now()) / 1000)) : null;
    return { runId: this.runId, maxSeconds: this.maxSeconds, remainingSeconds, mode: this.mode, epoch: this.mode === "auto" ? this.epoch : null, connected: this.connected, reason: this.reason, agent: !!this.agent, thinking: !!this.running, consolidating: this.consolidating };
  }

  list() { return this.devices.catalog; }

  async start(message?: string) {
    if (this.mode !== "manual" || this.running) throw new Error("Previous control cycle has not finished");
    if (!this.connected) throw new Error("Baseware disconnected; restart the application");
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.mode = "acquiring";
    this.opening = this.devices.acquire(epoch);
    try { await this.opening; }
    catch (error) { await this.stop(String(error)); throw error; }
    if (control.signal.aborted) return this.status();
    this.takeoverDeadlineMs = performance.now() + this.maxSeconds * 1000;
    this.mode = "auto";
    this.reason = "enabled";
    this.record("control", this.status(), { epoch });
    if (message) this.record("user_message", { text: message }, { epoch });
    this.timer = setTimeout(() => void this.stop("time budget").catch((e) => this.record("error", String(e))), this.maxSeconds * 1000);
    if (this.agent) {
      this.running = this.agent.run({ epoch, signal: control.signal, message })
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
    if (!this.agent) throw new Error("Consolidation requires an agent");
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.consolidating = true;
    this.reason = "consolidating";
    this.record("consolidation_start", { seconds }, { epoch });
    this.timer = setTimeout(() => void this.stop("consolidation time budget"), seconds * 1000);
    let outcome = "completed";
    this.running = this.agent.consolidate({ epoch, signal: control.signal })
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

  private abortAgent() {
    this.aborting = this.agent?.abort().catch((e) => this.record("error", String(e)));
  }

  async stop(reason = "human") {
    if (this.stopping) return this.stopping;
    if (this.mode === "manual") {
      if (this.consolidating && !this.control?.signal.aborted) {
        this.reason = reason;
        this.control?.abort();
        clearTimeout(this.timer);
        this.abortAgent();
      }
      return;
    }
    this.mode = "releasing";
    this.reason = reason;
    this.control?.abort();
    clearTimeout(this.timer);
    // Revoking the device never waits for model cancellation.
    this.abortAgent();
    this.stopping = (async () => {
      await this.opening?.catch(() => {});
      try { await this.devices.release(this.epoch); }
      catch (error) {
        this.connected = false;
        this.record("error", String(error));
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

  async observe(request: ObservationRequest, signal: AbortSignal, parent: EventTrace = {}, origin: ObservationOrigin = "cli"): Promise<Observation[]> {
    return await this.devices.observe(request, signal, parent, origin);
  }

  async close() {
    await this.stop("shutdown");
    await this.running;
    await this.agent?.close();
  }
}
