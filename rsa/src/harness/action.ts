import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { pythonExecutable } from "../../../shared/python.ts";
import { pythonModulePaths } from "./python-capabilities.ts";
import { childTrace, type DiagnosticsMode, type EventTrace, type RecordEvent } from "./events.ts";
import { PythonWorker } from "./python-worker.ts";

export interface ActionStatus {
  state: "idle" | "loading" | "ready" | "unimplemented" | "error" | "stopped";
  enabled: boolean; generation: string | null; epoch: string | null;
  pid?: number; codeSHA?: string; stepHz?: number; error?: string;
}

/** One epoch-bound Python program; no automatic replay after a step fails. */
export class ActionRuntime {
  private current: ActionStatus = { state: "idle", enabled: true, generation: null, epoch: null };
  private worker?: PythonWorker;
  private epoch?: string;
  private admitted?: string;
  private leaseEpoch?: string;
  private granting?: Promise<void>;
  private revision = 0;
  private closing?: Promise<void>;
  private transition: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;

  constructor(private readonly options: {
    workspace: string; runDir: string; env?: NodeJS.ProcessEnv; diagnostics?: DiagnosticsMode; record: RecordEvent;
    isAuto(epoch: string): boolean;
    setInputGeneration(epoch: string, generation: string | null): Promise<void>;
    onCleanupError(error: Error): void;
    startTimeoutMs?: number;
  }) { this.workspace = resolve(options.workspace); }

  status(): ActionStatus { return { ...this.current }; }

  accepts(epoch: string | undefined, generation: string): boolean {
    return !!epoch && epoch === this.epoch && generation === this.admitted && this.options.isAuto(epoch);
  }

  activate(epoch: string) {
    this.epoch = epoch;
    const revision = ++this.revision;
    return this.enqueue(() => this.replace(revision));
  }

  reload(epoch?: string) {
    this.epoch = epoch;
    this.admitted = undefined;
    this.current.enabled = true;
    const revision = ++this.revision;
    const closing = this.closeWorker();
    return this.enqueue(async () => { await closing; return this.replace(revision); });
  }

  stop() {
    this.admitted = undefined;
    this.current.enabled = false;
    ++this.revision;
    const closing = this.closeWorker();
    return this.enqueue(async () => {
      await closing;
      this.setStatus({ ...this.current, state: "stopped", epoch: null, pid: undefined });
      return this.status();
    });
  }

  deactivate() {
    // Admission closes synchronously; a slow Python shutdown cannot retain input access.
    this.epoch = undefined;
    this.admitted = undefined;
    ++this.revision;
    const closing = this.closeWorker();
    return this.enqueue(async () => {
      await closing;
      this.setStatus({ ...this.current, state: this.current.state === "error" || this.current.state === "unimplemented"
        ? this.current.state : this.current.enabled ? "idle" : "stopped", epoch: null, pid: undefined });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.transition.then(operation);
    this.transition = pending.catch(() => {});
    return pending;
  }

  private setStatus(status: ActionStatus, trace: EventTrace = {}) {
    const epoch = status.epoch ?? this.current.epoch;
    const changed = (["state", "enabled", "generation", "epoch", "error"] as const)
      .some(key => status[key] !== this.current[key]);
    this.current = status;
    if (!changed) return; // PID/rate updates stay visible in status without duplicate lifecycle bubbles.
    this.options.record("action_status", status, { recordingId: basename(this.options.runDir),
      ...(epoch ? { epoch } : {}), ...(status.generation ? { inputGeneration: status.generation } : {}), ...trace });
  }

  private fail(worker: PythonWorker, state: "error" | "unimplemented", error: string) {
    if (this.worker !== worker || worker.expectedExit || this.current.state === "error" || this.current.state === "unimplemented") return;
    this.admitted = undefined;
    this.setStatus({ ...this.current, state, error });
    const closing = this.closeWorker();
    void this.enqueue(async () => {
      await closing;
      this.setStatus({ ...this.current, pid: undefined });
    }).catch(() => {}); // closeWorker reports cleanup failure and hands control back.
  }

  private closeWorker(): Promise<void> {
    this.admitted = undefined;
    if (this.closing) return this.closing;
    const worker = this.worker, epoch = this.leaseEpoch, granting = this.granting;
    this.leaseEpoch = undefined;
    if (worker) worker.expectedExit = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
        worker?.stop(),
        (async () => {
          // A delayed grant reply must not install authority after stop has finished.
          await granting?.catch(() => {});
          if (epoch && this.options.isAuto(epoch)) await this.options.setInputGeneration(epoch, null);
        })(),
      ]);
      if (this.worker === worker) this.worker = undefined;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        const error = new Error(`Action input cleanup failed: ${String(failed.reason)}`);
        this.setStatus({ ...this.current, state: "error", pid: undefined, error: error.message });
        this.options.onCleanupError(error);
        throw error;
      }
    })().finally(() => { this.closing = undefined; });
    // A management request can arrive while a previous load is still completing.
    // Rejection is also observed by the serialized caller, but never left unhandled.
    void this.closing.catch(() => {});
    return this.closing;
  }

  private async replace(revision: number): Promise<ActionStatus> {
    await this.closeWorker();
    if (revision !== this.revision) return this.status();
    const epoch = this.epoch;
    if (!this.current.enabled || !epoch || !this.options.isAuto(epoch)) {
      this.setStatus({ state: this.current.enabled ? "idle" : "stopped", enabled: this.current.enabled, generation: null, epoch: null });
      return this.status();
    }
    let source: Buffer;
    try { source = await readFile(join(this.workspace, "action.py")); }
    catch (error) {
      this.setStatus({ state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unimplemented" : "error",
        enabled: true, generation: null, epoch, error: `Implement workspace/action.py:Action, then run rsa action reload. ${String(error)}` });
      return this.status();
    }
    const generation = crypto.randomUUID(), codeSHA = createHash("sha256").update(source).digest("hex");
    const directory = join(this.options.runDir, "action", generation);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "action.py"), source);
    if (revision !== this.revision || epoch !== this.epoch || !this.current.enabled || !this.options.isAuto(epoch)) return this.status();
    const trace = childTrace({ recordingId: basename(this.options.runDir), epoch, inputGeneration: generation, recordingPurpose: "continuous-action" });
    this.setStatus({ state: "loading", enabled: true, generation, epoch, codeSHA }, trace);
    try {
      this.leaseEpoch = epoch;
      const granting = this.granting = this.options.setInputGeneration(epoch, generation);
      try { await granting; } finally { if (this.granting === granting) this.granting = undefined; }
      if (revision !== this.revision || epoch !== this.epoch || !this.current.enabled || !this.options.isAuto(epoch)) {
        await this.closeWorker(); return this.status();
      }
      this.admitted = generation;
      const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, RSA_WORKSPACE: this.workspace,
        RSA_RUN_ID: basename(this.options.runDir), BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(trace),
        RSA_LOG_DIAGNOSTICS: this.options.diagnostics ?? "normal" };
      env.PYTHONPATH = [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
      const worker = new PythonWorker(generation, {
        executable: pythonExecutable(env), module: "rsa_tools._action", workspace: this.workspace, env,
        stderrPath: join(directory, "stderr.log"),
        onEvent: event => {
          if (this.worker !== worker) return;
          if (event.event === "recording" && event.type) this.options.record(event.type, event.data, event.trace ?? trace,
            { source: { component: "workspace", implementation: "action" }, ...(event.channel ? { channel: event.channel } : {}), ...(event.origin ? { origin: event.origin } : {}) });
          if (event.event !== "status" || worker.expectedExit) return;
          if (event.state === "error" || event.state === "unimplemented") this.fail(worker, event.state, String(event.error));
          else if (event.state === "ready" && this.accepts(epoch, generation)) this.setStatus({ ...this.current, state: "ready", error: undefined }, trace);
        },
        onExit: error => { if (!worker.expectedExit) this.fail(worker, "error", error.message); },
      });
      this.worker = worker;
      this.setStatus({ ...this.current, pid: worker.process.pid }, trace);
      const reply = await worker.request({ action: "start", workspace: this.workspace, runDir: this.options.runDir,
        generation, source: source.toString("utf8"), epoch, trace, diagnostics: this.options.diagnostics ?? "normal" }, this.options.startTimeoutMs ?? 30_000);
      if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
      const result = reply.result as { stepHz?: number; state: ActionStatus["state"]; error?: string };
      if (result.state === "error" || result.state === "unimplemented") this.fail(worker, result.state, result.error ?? result.state);
      if (this.worker === worker) this.setStatus({ ...this.current, stepHz: result.stepHz }, trace);
    } catch (error) {
      this.admitted = undefined;
      await this.closeWorker();
      if (revision === this.revision) this.setStatus({ ...this.current, state: "error", pid: undefined, error: String(error) }, trace);
    }
    return this.status();
  }
}
