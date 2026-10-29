import type { ExecutionResult, ToolArguments } from "@ludens/baseware/contracts";
import type { Catalog } from "@ludens/baseware/protocol";
import type { DiagnosticsMode, EventTrace, RecordEvent } from "./events.ts";
import type { PerceptionRuntime } from "./perception.ts";
import type { WorkspaceController } from "./controller.ts";
import type { ActionRuntime } from "./action.ts";
import { executeProgram, type Program } from "./program.ts";

export interface AgentRunner {
  run(context: { epoch: string; signal: AbortSignal; message?: string }): Promise<void>;
  consolidate(context: { epoch: string; signal: AbortSignal }): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export type ObservationOrigin = "cli" | "explicit" | "prompt_start" | "tool_batch";

export interface DeviceSession {
  readonly catalog: Catalog;
  readonly diagnostics?: DiagnosticsMode;
  acquire(epoch: string): Promise<void>;
  release(epoch: string): Promise<void>;
  setInputGeneration?(epoch: string, generation: string | null): Promise<void>;
  execute(id: string, args: ToolArguments, epoch: string | undefined, signal: AbortSignal, trace: EventTrace, origin?: ObservationOrigin): Promise<ExecutionResult>;
}

/** An enclosing Shiori owns this deadline and signals its measurement boundary. */
export interface SharedBudget {
  deadlineMs: number;
  signal: AbortSignal;
}

export class Runtime {
  private epoch = "";
  private mode: "manual" | "acquiring" | "auto" | "releasing" = "manual";
  private control?: AbortController;
  private opening?: Promise<void>;
  private stopping?: Promise<void>;
  private running?: Promise<void>;
  private aborting?: Promise<void>;
  /** Resolves when the active agent run fully settles (including post-abort cleanup); undefined when idle. */
  get runSettled(): Promise<void> | undefined { return this.running; }
  private consolidating = false;
  private timer?: ReturnType<typeof setTimeout>;
  private takeoverDeadlineMs = 0;
  private readonly budgetEnded = () => { void this.stop("time budget").catch(error => this.record("error", String(error))); };
  private reason = "startup";
  private connected = true;
  private perceptionInjection = true;
  private ownsDevice = false;
  private calls = new Set<Promise<unknown>>();
  agent?: AgentRunner;
  controller?: WorkspaceController;
  perception?: PerceptionRuntime;
  action?: ActionRuntime;

  constructor(private devices: DeviceSession | undefined, readonly record: RecordEvent, private maxSeconds = 300, private runId: string = crypto.randomUUID(), readonly diagnostics: DiagnosticsMode = "normal", private budget?: SharedBudget) {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds * 1000 > 2_147_483_647) throw new Error("Invalid Shiori time budget");
    if (budget && !Number.isFinite(budget.deadlineMs)) throw new Error("Invalid shared Shiori deadline");
  }

  status() {
    // The host can outlive many takeovers; its log clock is not this cycle's budget.
    const remainingSeconds = this.mode === "auto" ? Math.max(0, Math.ceil((this.takeoverDeadlineMs - performance.now()) / 1000)) : null;
    return { runId: this.runId, maxSeconds: this.maxSeconds, remainingSeconds, mode: this.mode, epoch: this.mode === "auto" ? this.epoch : null, connected: this.connected, reason: this.reason, agent: !!this.agent, thinking: !!this.running, consolidating: this.consolidating, perception: this.perception?.status(), action: this.action?.status(), context: { perceptionInjection: this.perceptionInjection }, logging: { diagnostics: this.diagnostics, basewareDiagnostics: this.devices?.diagnostics ?? "normal" } };
  }

  perceptionInjectionEnabled(): boolean { return this.perceptionInjection; }

  setPerceptionInjection(enabled: boolean, trace?: EventTrace) {
    if (this.perceptionInjection !== enabled) {
      this.perceptionInjection = enabled;
      this.record("context_policy", { perceptionInjection: enabled }, trace);
    }
    return { perceptionInjection: this.perceptionInjection };
  }

  list() { if (!this.devices) throw new Error("This Shiori execution has no device"); return this.devices.catalog; }

  checkInputGeneration(epoch: string | undefined, trace: EventTrace = {}) {
    if (trace.inputGeneration !== undefined && !this.action?.accepts(epoch, trace.inputGeneration))
      throw new Error("STALE_INPUT_GENERATION: reload the action program under the current control epoch");
  }

  async callController(id: string, args: unknown, epoch: string | undefined, signal: AbortSignal, trace: EventTrace = {}) {
    if (!this.controller) throw new Error("Workspace controller is unavailable");
    this.checkInputGeneration(epoch, trace);
    if ((epoch !== undefined || await this.controller.requiresControl(id, signal, trace)) && (this.mode !== "auto" || !epoch || epoch !== this.epoch)) {
      throw new Error("STALE_EPOCH: use the current control epoch");
    }
    const combined = epoch ? AbortSignal.any([signal, this.control!.signal]) : signal;
    combined.throwIfAborted();
    this.checkInputGeneration(epoch, trace);
    const call = this.controller.call(id, args, { epoch, signal: combined, trace: { ...trace, epoch } });
    // Background perception reads have no lease and outlive control cycles.
    // Only calls owned by this epoch need draining before another takeover.
    if (epoch !== undefined) this.calls.add(call);
    try { return await call; }
    finally { this.calls.delete(call); }
  }

  async start(message?: string, program?: (context: { epoch: string; signal: AbortSignal }) => Promise<void>) {
    if (this.mode !== "manual" || this.running || this.calls.size) throw new Error("Previous control cycle has not finished");
    if (!this.connected) throw new Error("Baseware disconnected; restart the application");
    this.budget?.signal.throwIfAborted();
    const epoch = this.epoch = crypto.randomUUID();
    const control = this.control = new AbortController();
    this.ownsDevice = !program;
    if (this.ownsDevice && !this.devices) throw new Error("Agent control requires a device session");
    this.mode = "acquiring";
    this.opening = this.ownsDevice ? this.devices!.acquire(epoch) : Promise.resolve();
    if (this.budget) {
      this.budget.signal.addEventListener("abort", this.budgetEnded, { once: true });
      if (this.budget.signal.aborted) this.budgetEnded();
    }
    try { await this.opening; }
    catch (error) { await this.stop(String(error)); throw error; }
    if (control.signal.aborted) return this.status();
    this.takeoverDeadlineMs = performance.now() + (this.budget ? this.budget.deadlineMs - Date.now() : this.maxSeconds * 1000);
    this.mode = "auto";
    this.reason = "enabled";
    this.record("control", this.status(), { epoch });
    if (message) this.record("user_message", { text: message }, { epoch });
    if (!this.budget) this.timer = setTimeout(this.budgetEnded, this.maxSeconds * 1000);
    if (control.signal.aborted) return this.status();
    try { if (this.ownsDevice) await this.action?.activate(epoch); }
    catch (error) { await this.stop(String(error)); throw error; }
    if (control.signal.aborted) return this.status();
    const work = program ?? (this.agent ? (context: { epoch: string; signal: AbortSignal }) => this.agent!.run({ ...context, message }) : undefined);
    if (work) {
      this.running = Promise.resolve().then(() => work({ epoch, signal: control.signal }))
        .catch((error) => { if (!control.signal.aborted) this.record("error", String(error)); })
        .finally(async () => {
          await this.stop("agent ended");
          await this.aborting;
          this.running = undefined;
        });
    }
    return this.status();
  }

  /** Ordinary programs use Shiori's same budget, cancellation and drain path, without OMP or a device lease. */
  async runProgram(program: Program, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let failure: unknown;
    const cancel = () => { void this.stop("cancelled"); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.start(undefined, async ({ signal: controlSignal }) => {
        const deadlineMs = Date.now() + this.takeoverDeadlineMs - performance.now();
        try { await executeProgram(program, controlSignal, this.record, deadlineMs, signal); }
        catch (error) { failure = error; throw error; }
      });
      if (signal?.aborted) cancel();
      await this.running;
      if (failure) throw failure;
      signal?.throwIfAborted();
    } finally { signal?.removeEventListener("abort", cancel); }
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
        this.control?.abort(new DOMException(reason, "AbortError"));
        clearTimeout(this.timer);
        this.abortAgent();
      }
      return;
    }
    this.mode = "releasing";
    this.reason = reason;
    this.control?.abort(reason === "time budget" ? new DOMException(reason, "AbortError") : undefined);
    clearTimeout(this.timer);
    this.budget?.signal.removeEventListener("abort", this.budgetEnded);
    // Revoking the device never waits for model cancellation.
    this.abortAgent();
    const actionStopped = this.action?.deactivate();
    void actionStopped?.catch(error => this.record("error", String(error), { epoch: this.epoch }));
    this.stopping = (async () => {
      await this.opening?.catch(() => {});
      try { if (this.ownsDevice) await this.devices!.release(this.epoch); }
      catch (error) {
        this.connected = false;
        this.record("error", String(error));
      }
      // The device is already released; let cancelled workspace calls finish
      // before another epoch can start. Nested calls need no global queue.
      await Promise.allSettled(this.calls);
      await actionStopped?.catch(() => {});
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

  async close() {
    try {
      await this.stop("shutdown");
      await this.running;
      await this.agent?.close();
    } finally {
      try { await this.action?.deactivate(); }
      finally { await this.perception?.stop(); }
    }
  }
}
