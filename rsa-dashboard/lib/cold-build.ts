import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getLogIndex, indexStorageRoot, type LogIndex } from "./log-index";
import { archiveBudget } from "./archive-budget";
import { verifySources } from "./cold-source";
import type { ArchiveBuildState, BuilderReply, BuilderRequest, CapturedSource } from "./cold-build-protocol";
export type { ArchiveBuildState } from "./cold-build-protocol";

type Job = { path: string; root: string; workspace?: string | null; state: ArchiveBuildState;
  abort: AbortController; child?: ChildProcess; done?: Promise<void> };
const terminal = (state: ArchiveBuildState) => state.state === "ready" || state.state === "failed" || state.state === "cancelled";
const conflict = (message: string) => Object.assign(new Error(message), { status: 409, code: "ARCHIVE_BUILD_CHANGED" });
const activeGeneration = (root: string) => {
  try { return JSON.parse(readFileSync(join(root, "active.json"), "utf8")).generation as string; }
  catch { return undefined; }
};
function save(root: string, state: ArchiveBuildState) {
  mkdirSync(root, { recursive: true });
  const file = join(root, "build.json"), temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, file);
}
function saved(root: string): ArchiveBuildState | null {
  const file = join(root, "build.json");
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, "utf8")) as ArchiveBuildState;
  if (!/^[a-f0-9-]{36}$/.test(state.id)) throw new Error("无效的档案构建状态");
  return state;
}

/** One finite child at a time. HTTP requests observe this work; they do not own it. */
export class ArchiveBuildManager {
  private jobs = new Map<string, Job>();
  private running?: Job;
  private closing = false;
  constructor(private options: { entry?: string; env?: NodeJS.ProcessEnv } = {}) {}

  state(index: LogIndex): ArchiveBuildState | null {
    const job = this.jobs.get(index.path);
    if (job) return { ...job.state };
    const root = indexStorageRoot(index.path), state = saved(root);
    if (state && !terminal(state)) {
      // The previous manager is gone. Never silently resume an interrupted build.
      state.state = "failed"; state.error = "上次目录构建被中断，请重试"; delete state.pid;
      if (activeGeneration(root) === state.id) {
        state.state = "ready"; state.generation = state.id; delete state.error;
      } else rmSync(join(root, "generations", state.id), { recursive: true, force: true });
      save(root, state);
    }
    return state;
  }

  ensure(index: LogIndex): ArchiveBuildState {
    if (this.closing) throw Object.assign(new Error("Dashboard 正在关闭"), { status: 503 });
    const previous = this.state(index);
    if (previous && (previous.state !== "ready" || index.meta("cold:ready") === "1" || getLogIndex(index.path) !== index)) return previous;
    return this.enqueue(index);
  }
  private enqueue(index: LogIndex): ArchiveBuildState {
    const root = indexStorageRoot(index.path), state: ArchiveBuildState = { id: randomUUID(), state: "queued", stage: "queued" };
    const job: Job = { path: index.path, root, workspace: index.archiveWorkspace, state, abort: new AbortController() };
    save(root, state); this.jobs.set(index.path, job); this.pump();
    return { ...state };
  }
  async control(index: LogIndex, options: { action?: "cancel" | "retry"; buildId?: string } = {}): Promise<ArchiveBuildState | null> {
    const previous = this.state(index);
    if (!options.action) return previous;
    if (this.closing) throw Object.assign(new Error("Dashboard 正在关闭"), { status: 503 });
    if (previous && options.buildId !== previous.id) throw conflict("构建已变化，请刷新状态后再操作");
    if (!previous && options.buildId) throw conflict("构建已变化，请刷新状态后再操作");
    const job = this.jobs.get(index.path);
    if (options.action === "retry") {
      if (job) throw conflict("目录仍在构建，请先取消或等待完成");
      return this.enqueue(index);
    }
    if (!job) return previous;
    // Publication and the ready transition are synchronous. A later cancel is a no-op.
    if (job.state.state === "ready") return { ...job.state };
    job.abort.abort(); this.stopChild(job);
    if (job.done) await job.done;
    else {
      job.state = { ...job.state, state: "cancelled", stage: "cancelled" };
      save(job.root, job.state); this.jobs.delete(job.path);
    }
    this.pump(); return this.state(index);
  }
  private pump() {
    if (this.running || this.closing) return;
    const job = [...this.jobs.values()].find(value => value.state.state === "queued");
    if (!job) return;
    this.running = job;
    job.done = this.run(job).catch(error => {
      job.state = { ...job.state, state: "failed", error: (error as Error).message }; delete job.state.pid;
      save(job.root, job.state);
    }).finally(() => {
      this.jobs.delete(job.path); this.running = undefined; this.pump();
    });
  }
  private stopChild(job: Job) {
    const child = job.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.send({ type: "cancel" } satisfies BuilderRequest); } catch { /* already disconnecting */ }
    child.kill("SIGTERM");
  }
  private async child(job: Job, directory: string): Promise<{ source: CapturedSource; value: Partial<ArchiveBuildState> }> {
    const env = this.options.env ?? process.env, budget = archiveBudget(env);
    const entry = this.options.entry ?? fileURLToPath(new URL("../worker/cold-builder.mjs", import.meta.url));
    const child = fork(entry, [], { execArgv: [`--max-old-space-size=${budget.builderHeapMiB}`], env,
      stdio: ["ignore", "ignore", "pipe", "ipc"] });
    job.child = child; job.state.pid = child.pid; save(job.root, job.state);
    return new Promise((resolve, reject) => {
      let result: Extract<BuilderReply, { type: "done" }> | undefined, message: string | undefined, errorCode: string | undefined, stderr = "";
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => {
        this.stopChild(job);
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      };
      job.abort.signal.addEventListener("abort", aborted, { once: true });
      child.stderr?.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
      child.on("message", (reply: BuilderReply) => {
        if (reply.type === "progress") job.state = { ...job.state, ...reply.value, id: job.state.id, state: "building" };
        else if (reply.type === "done") result = reply;
        else if (reply.type === "error") { message = reply.message; errorCode = reply.code; }
      });
      child.once("error", error => { message = error.message; });
      child.once("close", code => {
        if (killTimer) clearTimeout(killTimer);
        job.abort.signal.removeEventListener("abort", aborted); delete job.child;
        if (job.abort.signal.aborted) reject(job.abort.signal.reason);
        else if (code === 0 && result) resolve(result);
        else reject(Object.assign(new Error(message || stderr.trim() || `构建进程异常退出 (${code})`), { code: errorCode }));
      });
      child.send({ type: "build", id: job.state.id, path: job.path, directory,
        workspace: job.workspace, budgetBytes: budget.buildBytes } satisfies BuilderRequest);
      if (job.abort.signal.aborted) aborted();
    });
  }
  private async run(job: Job) {
    const started = Date.now(), index = getLogIndex(job.path), release = index.retain();
    const directory = join(job.root, "generations", job.state.id);
    let published = false, sourceInvalid = false;
    job.state.state = "building"; job.state.stage = "snapshot"; save(job.root, job.state);
    try {
      await index.freeze(); job.abort.signal.throwIfAborted();
      const result = await this.child(job, directory);
      job.abort.signal.throwIfAborted();
      await verifySources(job.path, result.source, job.abort.signal);
      job.abort.signal.throwIfAborted();
      if (this.jobs.get(job.path) !== job) throw conflict("构建已被替换");
      // No await between the last cancellation check and publication.
      const temporary = join(job.root, `active.${job.state.id}.tmp`);
      writeFileSync(temporary, JSON.stringify({ generation: job.state.id }));
      renameSync(temporary, join(job.root, "active.json")); published = true;
      job.state = { ...job.state, ...result.value, id: job.state.id, state: "ready", stage: "ready",
        generation: job.state.id, elapsedMs: Date.now() - started }; delete job.state.pid;
      save(job.root, job.state);
      getLogIndex(job.path).archiveWorkspace = job.workspace;
    } catch (error) {
      if (published) return; // active.json is the commit point, even if status persistence fails afterwards.
      sourceInvalid = (error as { code?: string }).code === "ARCHIVE_SOURCE_CHANGED" || (error as Error).name === "SourceChanged";
      if (sourceInvalid) {
        index.invalidate();
        if (activeGeneration(job.root) === index.directory.split("/").at(-1)) rmSync(join(job.root, "active.json"), { force: true });
        getLogIndex(job.path);
      }
      job.state = { ...job.state, state: job.abort.signal.aborted ? "cancelled" : "failed",
        stage: job.abort.signal.aborted ? "cancelled" : "failed", elapsedMs: Date.now() - started,
        ...(job.abort.signal.aborted ? {} : { error: (error as Error).message }) };
      delete job.state.pid; save(job.root, job.state);
    } finally {
      if (!published) { if (!sourceInvalid) index.resume(); rmSync(directory, { recursive: true, force: true }); }
      release();
    }
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) { job.abort.abort(); this.stopChild(job); }
    await Promise.all([...this.jobs.values()].map(async job => {
      if (job.done) await job.done;
      else { job.state.state = "cancelled"; job.state.stage = "cancelled"; save(job.root, job.state); this.jobs.delete(job.path); }
    }));
  }
}

const key = Symbol.for("ludens.dashboard.archive-builder");
function manager(): ArchiveBuildManager { return (globalThis as any)[key] ??= new ArchiveBuildManager(); }
export const ensureArchiveBuild = (index: LogIndex) => manager().ensure(index);
export const controlArchiveBuild = (index: LogIndex, options: { action?: "cancel" | "retry"; buildId?: string } = {}) => manager().control(index, options);
export const archiveBuildState = (index: LogIndex) => manager().state(index);
export const closeArchiveBuilds = () => manager().close();
