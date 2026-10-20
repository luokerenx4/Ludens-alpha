import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Clock, ExecutionResult, Observation } from "@playness/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent } from "./events.ts";
import { pythonModulePaths } from "./python-capabilities.ts";

export interface PerceptionStatus {
  state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
  generation: string | null;
  pid?: number;
  codeSHA?: string;
  error?: string;
}
export interface PerceptionSnapshot {
  id: string;
  sequence: string | number;
  sampledAt?: string;
  sources?: unknown[];
}
export interface PerceptionRead {
  status: PerceptionStatus;
  result: ExecutionResult;
  snapshot?: PerceptionSnapshot;
  reused?: boolean;
  error?: string;
}
interface Reply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { type: string; message: string; traceback?: string };
}
interface Worker {
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>;
  exited: Promise<void>;
  expectedExit: boolean;
  generation: string;
}
interface Archived {
  snapshot: PerceptionSnapshot;
  text: string;
  observations: Observation[];
}

/** One workspace process owns perception. Only explicit reload replaces it. */
export class PerceptionRuntime {
  private current: PerceptionStatus = { state: "unimplemented", generation: null };
  private worker?: Worker;
  private archived = new Map<string, Archived>();
  private archiving = new Map<string, Promise<Archived>>();
  private transition: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;
  private readonly clock: Clock;

  constructor(private readonly options: {
    workspace: string; runDir: string; env?: NodeJS.ProcessEnv; record: RecordEvent; clock?: Clock;
    startTimeoutMs?: number; observeTimeoutMs?: number;
  }) {
    this.workspace = resolve(options.workspace);
    this.clock = options.clock ?? { id: basename(options.runDir), now: () => performance.now() };
  }

  status(): PerceptionStatus { return { ...this.current }; }

  reload(trace: EventTrace = {}): Promise<PerceptionStatus> {
    const operation = this.transition.then(() => this.replace(trace));
    this.transition = operation.catch(() => {});
    return operation;
  }

  stop(): Promise<void> {
    const operation = this.transition.then(async () => {
      await this.closeWorker();
      this.setStatus({ ...this.current, state: "stopped", pid: undefined, error: undefined });
    });
    this.transition = operation.catch(() => {});
    return operation;
  }

  async observe(signal: AbortSignal, parent: EventTrace = {}): Promise<PerceptionRead> {
    const trace = childTrace(parent), started = this.clock.now();
    const observedStatus = this.status(), worker = this.worker;
    const replaced = () => {
      const failed = this.current.generation === observedStatus.generation && this.current.state === "error";
      return this.finish(this.unavailable(
        failed ? this.current.error : "Perception generation stopped or was replaced during observation.",
        failed ? this.status() : { ...observedStatus, state: "stopped" },
      ), started, trace);
    };
    this.record("perception_observe_start", { status: observedStatus }, trace);
    try {
      signal.throwIfAborted();
      if (!worker || this.current.state === "loading" || this.current.state === "stopped") {
        return this.finish(this.unavailable(), started, trace);
      }
      const reply = await this.request(worker, { action: "observe", trace: withoutEpoch(trace) },
        this.options.observeTimeoutMs ?? 5000, signal);
      signal.throwIfAborted();
      if (!this.isCurrent(worker)) return replaced();
      if (!reply.ok) {
        const error = `${reply.error?.type}: ${reply.error?.message}`;
        this.setStatus({ ...this.current,
          state: reply.error?.type === "NotImplementedError" ? "unimplemented" : "error", error }, trace);
        return this.finish(this.unavailable(error), started, trace);
      }
      const value = reply.result;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("observe() must return a snapshot object");
      const { sequence, sampledAt, sources, text = "", media = [] } = value as Record<string, unknown>;
      if (!(typeof sequence === "string" && sequence.length > 0) && !(typeof sequence === "number" && Number.isFinite(sequence))) {
        throw new TypeError("observe() snapshot needs a string or finite number sequence");
      }
      if (sampledAt !== undefined && (typeof sampledAt !== "string" || !Number.isFinite(Date.parse(sampledAt)))) {
        throw new TypeError("snapshot sampledAt must be an ISO timestamp when known");
      }
      if (sources !== undefined && !Array.isArray(sources)) throw new TypeError("snapshot sources must be an array");
      if (typeof text !== "string" || !Array.isArray(media)) throw new TypeError("snapshot text must be a string and media must be an array");
      const key = JSON.stringify([worker.generation, sequence]);
      let archive = this.archived.get(key);
      const reused = archive !== undefined || this.archiving.has(key);
      if (!archive) {
        let saving = this.archiving.get(key);
        if (!saving) {
          saving = this.archive({ id: crypto.randomUUID(), sequence,
            ...(sampledAt === undefined ? {} : { sampledAt: sampledAt as string }),
            ...(sources === undefined ? {} : { sources: sources as unknown[] }) }, text, media, started);
          this.archiving.set(key, saving);
        }
        try { archive = await saving; }
        finally { if (this.archiving.get(key) === saving) this.archiving.delete(key); }
        if (!this.isCurrent(worker)) return replaced();
        this.archived.set(key, archive);
      }
      signal.throwIfAborted();
      if (!this.isCurrent(worker)) return replaced();
      this.setStatus({ ...this.current, state: "ready", error: undefined }, trace);
      const result = this.execution(archive.text, archive.observations, started);
      return this.finish({ status: this.status(), result, snapshot: archive.snapshot, reused }, started, trace);
    } catch (error) {
      if (signal.aborted) {
        const result = this.execution("", [], started, "Observation wait cancelled");
        result.status = "interrupted";
        this.record("perception_observe_end", { status: observedStatus, result, outcome: "cancelled",
          durationMs: this.clock.now() - started }, trace);
        throw signal.reason ?? error;
      }
      if (worker && !this.isCurrent(worker)) return replaced();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ ...this.current, state: "error", error: message }, trace);
      return this.finish(this.unavailable(message), started, trace);
    }
  }

  private async replace(trace: EventTrace): Promise<PerceptionStatus> {
    await this.closeWorker();
    this.archived.clear();
    this.archiving.clear();
    let source: Buffer;
    try { source = await readFile(join(this.workspace, "perception.py")); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.setStatus({ state: missing ? "unimplemented" : "error", generation: null,
        error: missing ? "Implement workspace/perception.py:Perception, then run rsa perception reload." : String(error) }, trace);
      return this.status();
    }
    const generation = crypto.randomUUID(), codeSHA = createHash("sha256").update(source).digest("hex");
    this.setStatus({ state: "loading", generation, codeSHA }, trace);
    const directory = join(this.options.runDir, "perception", generation);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "perception.py"), source);
    const backgroundTrace = childTrace();
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, RSA_WORKSPACE: this.workspace,
      RSA_RUN_ID: basename(this.options.runDir), BASEWARE_TRACE: JSON.stringify(backgroundTrace) };
    for (const key of ["RSA_EPOCH", "RSA_TRACE", "BASEWARE_EPOCH"]) delete (env as NodeJS.ProcessEnv)[key];
    env.PYTHONPATH = [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
    const child = spawn(env.RSA_PYTHON ?? "python3", ["-u", "-m", "rsa_tools._perception"], {
      cwd: this.workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = createWriteStream(join(directory, "stderr.log"));
    child.stderr.pipe(stderr);
    let tail = "";
    child.stderr.on("data", data => { tail = (tail + data.toString()).slice(-2000); });
    let onExit!: () => void;
    const worker: Worker = { process: child, pending: new Map(), generation, expectedExit: false,
      exited: new Promise(resolve => { onExit = resolve; }) };
    this.worker = worker;
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let reply: Reply;
      try { reply = JSON.parse(line); }
      catch { return; }
      const pending = worker.pending.get(reply.id);
      if (pending) { worker.pending.delete(reply.id); pending.resolve(reply); }
    });
    const closed = (error: Error) => {
      for (const pending of worker.pending.values()) pending.reject(error);
      worker.pending.clear();
      if (this.worker === worker) {
        this.worker = undefined;
        if (!worker.expectedExit) this.setStatus({ ...this.current, state: "error", pid: undefined, error: error.message });
      }
      onExit();
    };
    child.once("error", closed);
    child.once("close", (code, signal) => {
      lines.close();
      closed(new Error(`Perception process exited (${signal ?? code})${tail ? `: ${tail.trim()}` : ""}`));
    });
    // Background reads are rooted at this generation, not at the model call
    // that happened to reload it. Its status event makes that root discoverable.
    this.setStatus({ ...this.current, pid: child.pid }, backgroundTrace);
    try {
      const reply = await this.request(worker, { action: "start", workspace: this.workspace,
        runDir: this.options.runDir, generation, source: source.toString("utf8"), trace: backgroundTrace },
      this.options.startTimeoutMs ?? 30_000);
      if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
      this.setStatus({ ...this.current, state: "ready" }, trace);
    } catch (error) {
      await this.closeWorker();
      this.setStatus({ ...this.current, state: "error", pid: undefined, error: String(error) }, trace);
    }
    return this.status();
  }

  private request(worker: Worker, message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => { worker.pending.delete(id); cleanup(); reject(signal?.reason ?? new Error("Observation wait cancelled")); };
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        cleanup();
        reject(new Error(`Perception ${message.action} timed out after ${timeoutMs} ms; repair the implementation and reload it.`));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      worker.pending.set(id, { resolve: reply => { cleanup(); resolve(reply); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.process.stdin.write(JSON.stringify({ ...message, id }) + "\n", error => {
        if (error) {
          const pending = worker.pending.get(id);
          worker.pending.delete(id);
          pending?.reject(error);
        }
      });
    });
  }

  private async closeWorker() {
    const worker = this.worker;
    if (!worker) return;
    worker.expectedExit = true;
    const kill = (signal: NodeJS.Signals) => {
      if (!worker.process.pid) return;
      try { process.kill(-worker.process.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1000);
    try { await worker.exited; }
    finally { clearTimeout(timer); }
  }

  private isCurrent(worker: Worker) {
    return this.worker === worker && !worker.expectedExit && this.current.generation === worker.generation;
  }

  private async archive(snapshot: PerceptionSnapshot, text: string, media: unknown[], started: number): Promise<Archived> {
    const observations: Observation[] = [];
    const directory = join(this.options.runDir, "observations");
    await mkdir(directory, { recursive: true });
    for (const item of media) {
      if (!item || typeof item !== "object" || !("path" in item) || !("mediaType" in item)
        || typeof item.path !== "string" || typeof item.mediaType !== "string") {
        throw new TypeError("snapshot media entries need path and mediaType strings");
      }
      const id = crypto.randomUUID(), path = join(directory, `${id}-${basename(item.path)}`);
      await writeFile(path, await readFile(resolve(this.workspace, item.path)), { flag: "wx" });
      observations.push({ id, controllerId: "perception", mediaType: item.mediaType, path,
        timing: { clock: this.clock.id, requestedAtMs: started, receivedAtMs: this.clock.now() } });
    }
    return { snapshot, text, observations };
  }

  private unavailable(error = this.current.error ?? `Perception is ${this.current.state}.`, status = this.status()): PerceptionRead {
    return { status, result: this.execution(error, [], this.clock.now(), error), error };
  }

  private execution(text: string, observations: Observation[], started: number, error?: string): ExecutionResult {
    return { id: crypto.randomUUID(), status: error ? "failed" : "completed", exitCode: error ? 1 : 0,
      stdout: text, stderr: error ?? "", observations,
      timing: { clock: this.clock.id, requestedAtMs: started, receivedAtMs: this.clock.now() } };
  }

  private finish(read: PerceptionRead, started: number, trace: EventTrace) {
    this.record("perception_observe_end", { ...read, outcome: read.error ? "error" : "success",
      durationMs: this.clock.now() - started }, trace);
    return read;
  }

  private setStatus(status: PerceptionStatus, trace?: EventTrace) {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    this.record("perception_status", status, trace);
  }

  private record(type: string, data: unknown, trace?: EventTrace) {
    this.options.record(type, data, trace, { source: { component: "perception", implementation: "python" } });
  }
}

function withoutEpoch(trace: EventTrace): EventTrace {
  const { epoch, ...rest } = trace;
  return rest;
}
