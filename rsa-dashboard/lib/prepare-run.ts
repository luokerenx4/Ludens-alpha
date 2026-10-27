import type { LogIndex } from "./log-index";
import { ensureArchiveBuild } from "./cold-build";

type Progress = { position: number; total: number; complete: boolean };
type Work = { controller: AbortController; consumers: number; promise: Promise<void> };
const work = new WeakMap<LogIndex, Map<string, Work>>();

function requirePublished(index: LogIndex) {
  if (index.meta("cold:ready") === "1") return;
  const progress = ensureArchiveBuild(index);
  if (progress.state === "cancelled" || progress.state === "failed")
    throw Object.assign(new Error(progress.error ?? "目录构建已取消，请明确重试"), {
      status: 409, code: progress.state === "cancelled" ? "ARCHIVE_CANCELLED" : "ARCHIVE_BUILD_FAILED", progress });
  throw Object.assign(new Error("正在准备历史目录"), { status: 202, code: "ARCHIVE_PREPARING", progress });
}

/** Cold construction belongs to a finite child job. Only small warm tails follow the HTTP reader. */
export async function prepareArchive(index: LogIndex, options: { kind: string;
  step: (signal: AbortSignal) => Promise<unknown>; progress: () => Progress; signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
  requirePublished(index);
  // A rebuild freezes an already published generation. Existing snapshots remain readable.
  if (index.frozen) return;
  let jobs = work.get(index);
  if (!jobs) { jobs = new Map(); work.set(index, jobs); }
  let job = jobs.get(options.kind);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const next: Work = { controller, consumers: 0, promise: undefined! };
    next.promise = (async () => {
      const until = Date.now() + 1000;
      do {
        controller.signal.throwIfAborted();
        await index.refreshEvents({ maxBytes: 1024 * 1024, signal: controller.signal });
        await options.step(controller.signal);
        if (index.progress.complete && options.progress().complete) return;
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (Date.now() < until);
    })().finally(() => { if (jobs!.get(options.kind) === next) jobs!.delete(options.kind); });
    // A departed last reader need not keep the job alive or leave a rejected promise.
    void next.promise.catch(() => {});
    jobs.set(options.kind, next); job = next;
  }
  job.consumers++;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([job.promise, new Promise<never>((_, reject) => {
      abort = () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    })]);
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (--job.consumers === 0) job.controller.abort();
  }
  options.signal?.throwIfAborted();
  // A source replacement can reset the index during warm refresh. Its partial
  // rebuild is not a published snapshot and must enter the cold path again.
  requirePublished(index);
  const progress = { ...index.progress, projection: options.progress() };
  if (!progress.complete || !progress.projection.complete)
    throw Object.assign(new Error("正在准备历史目录"), { status: 202, code: "ARCHIVE_PREPARING", progress });
}
