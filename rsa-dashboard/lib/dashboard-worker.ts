import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import type { DashboardMethod, DashboardMethods, WorkerRequest, WorkerResponse } from "./dashboard-protocol";

type Waiting = { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };
interface WorkerOptions { file?: string; env?: NodeJS.ProcessEnv; maxPending?: number; timeoutMs?: number }
const unavailable = (message: string) => Object.assign(new Error(message), { status: 503, code: "DASHBOARD_WORKER_UNAVAILABLE" });

/** One isolated archive reader per Next server, with no retained completed Promise chain. */
export class DashboardWorker {
  private worker?: Worker;
  private waiting = new Map<number, Waiting>();
  private sequence = 0;
  private closed = false;
  constructor(private options: WorkerOptions = {}) {}
  get pendingCount() { return this.waiting.size; }

  private start() {
    if (this.closed) throw unavailable("Dashboard reader is closed");
    if (this.worker) return this.worker;
    // Keep this a native Node constructor. Turbopack rewrites `new Worker(...)`
    // and would otherwise bundle the TypeScript backend back into the React runtime.
    const file = this.options.file ?? resolve(process.cwd(), "worker/bootstrap.mjs");
    const worker: Worker = Reflect.construct(Worker, [file, { execArgv: [], env: this.options.env,
      resourceLimits: { maxOldGenerationSizeMb: 512 } }]);
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => {
      if (message.type === "ready") return;
      const entry = this.waiting.get(message.id);
      if (!entry) return;
      this.waiting.delete(message.id); entry.cleanup();
      if (!this.waiting.size) worker.unref();
      if (message.type === "error") entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.value);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.rejectAll(unavailable(`Dashboard reader stopped: ${error.message}`));
    };
    worker.on("error", failed);
    worker.on("exit", code => failed(new Error(`worker exited (${code})`)));
    worker.unref();
    return worker;
  }
  private rejectAll(error: Error) {
    for (const entry of this.waiting.values()) { entry.cleanup(); entry.reject(error); }
    this.waiting.clear();
  }
  call<K extends DashboardMethod>(method: K, args: DashboardMethods[K]["args"], signal?: AbortSignal): Promise<DashboardMethods[K]["result"]> {
    signal?.throwIfAborted();
    if (this.waiting.size >= (this.options.maxPending ?? 64)) return Promise.reject(unavailable("Dashboard reader is busy; retry shortly"));
    const worker = this.start(), id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error: unknown) => {
        const entry = this.waiting.get(id);
        if (!entry) return;
        this.waiting.delete(id); entry.cleanup();
        try { worker.postMessage({ type: "cancel", id } satisfies WorkerRequest); } catch { /* worker already exited */ }
        if (!this.waiting.size) worker.unref();
        reject(error);
      };
      const aborted = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(unavailable("Dashboard reader timed out")), this.options.timeoutMs ?? 60_000);
      this.waiting.set(id, { resolve: value => resolve(value as DashboardMethods[K]["result"]), reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); } });
      signal?.addEventListener("abort", aborted, { once: true });
      worker.ref();
      try { worker.postMessage({ type: "call", id, method, args } satisfies WorkerRequest); }
      catch (error) { finish(error); }
    });
  }
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.rejectAll(unavailable("Dashboard reader is closing"));
    if (!worker) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { void worker.terminate(); }, 2000);
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
      worker.ref();
      try { worker.postMessage({ type: "close" } satisfies WorkerRequest); } catch { void worker.terminate(); }
    });
  }
}

const key = Symbol.for("ludens.dashboard.reader-worker");
export function dashboardWorker(): DashboardWorker {
  return ((globalThis as any)[key] ??= new DashboardWorker()) as DashboardWorker;
}
