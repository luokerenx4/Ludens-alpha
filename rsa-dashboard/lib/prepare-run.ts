import type { LogIndex } from "./log-index";

type Progress = { position: number; total: number; complete: boolean };
type Work = { controller: AbortController; consumers: number; promise: Promise<void> };
const work = new WeakMap<LogIndex, Map<string, Work>>();

/** Cold preparation is resumable, time-sliced, and owned by active readers.
 * A 202 response is progress, never an empty successful history page. */
export async function prepareArchive(index: LogIndex, options: { kind: string;
  step: (signal: AbortSignal) => Promise<unknown>; progress: () => Progress; signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
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
  const progress = { ...index.progress, projection: options.progress() };
  if (!progress.complete || !progress.projection.complete)
    throw Object.assign(new Error("正在准备历史目录"), { status: 202, code: "ARCHIVE_PREPARING", progress });
}
