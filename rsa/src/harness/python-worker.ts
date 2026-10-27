import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

export interface WorkerReply {
  id: string; ok: boolean; result?: unknown;
  error?: { type: string; message: string; traceback?: string };
}

/** JSON-line transport and bounded process-group cleanup shared by resident Python entries. */
export class PythonWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  expectedExit = false;
  private pending = new Map<string, { resolve(reply: WorkerReply): void; reject(error: Error): void }>();

  constructor(readonly generation: string, options: {
    executable: string; module: string; workspace: string; env: NodeJS.ProcessEnv; stderrPath: string;
    onEvent(event: any): void; onExit(error: Error): void;
  }) {
    this.process = spawn(options.executable, ["-u", "-m", options.module], {
      cwd: options.workspace, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.process;
    const stderr = createWriteStream(options.stderrPath);
    child.stderr.pipe(stderr);
    let tail = "", finished = false;
    child.stderr.on("data", data => { tail = (tail + data.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let reply: WorkerReply & { event?: string };
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.event) { options.onEvent(reply); return; }
      const pending = this.pending.get(reply.id);
      if (pending) { this.pending.delete(reply.id); pending.resolve(reply); }
    });
    this.exited = new Promise(resolve => {
      const close = (error: Error) => {
        if (finished) return;
        finished = true;
        lines.close(); stderr.end();
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        options.onExit(error);
        resolve();
      };
      child.once("error", close);
      child.once("close", (code, signal) => close(new Error(`Python worker exited (${signal ?? code})${tail ? `: ${tail.trim()}` : ""}`)));
    });
  }

  request(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerReply> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.pending.delete(id); cleanup(); reject(signal?.reason ?? new Error("Worker request cancelled")); };
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup();
        reject(new Error(`Python worker ${message.action} timed out after ${timeoutMs} ms; repair the implementation and reload it.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: reply => { cleanup(); resolve(reply); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.process.stdin.write(JSON.stringify({ ...message, id }) + "\n", error => {
        if (!error) return;
        const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(error);
      });
    });
  }

  async stop() {
    this.expectedExit = true;
    const kill = (signal: NodeJS.Signals) => {
      if (!this.process.pid) return;
      try { process.kill(-this.process.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 10_000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
