import { performance } from "node:perf_hooks";
import { LogIndex, SourceChanged, resetStorageMetrics, storageMetrics } from "../lib/log-index";
import { createRunReducer } from "../lib/run-index";
import { createActivityReducer } from "../lib/activity";
import { refreshOperationIndex } from "../lib/operation-index";
import { captureSources, verifySources } from "../lib/cold-source";
import type { ArchiveBuildState, BuilderRequest, BuilderReply } from "../lib/cold-build-protocol";

const abort = new AbortController();
let started = false;
function send(message: BuilderReply) { if (process.connected) process.send?.(message); }
function stop() { abort.abort(); }
process.on("SIGTERM", stop);
// A dead manager cannot leave an autonomous builder behind.
process.on("disconnect", () => process.exit(1));
process.on("message", (message: BuilderRequest) => {
  if (message.type === "cancel") { stop(); return; }
  if (started) return;
  started = true;
  void build(message).then(() => process.exit(0), error => {
    process.send?.({ type: "error", message: (error as Error).message,
      code: error instanceof SourceChanged ? "ARCHIVE_SOURCE_CHANGED" : (error as { code?: string }).code } satisfies BuilderReply, () => process.exit(1));
  });
});

async function build(request: Extract<BuilderRequest, { type: "build" }>) {
  resetStorageMetrics();
  const begin = performance.now(), source = await captureSources(request.path, abort.signal);
  const index = new LogIndex(request.path, request.directory);
  index.archiveWorkspace = request.workspace; index.setSourceSnapshot(source.snapshot);
  index.beginBulk(request.budgetBytes);
  const totalEventBytes = Object.entries(source.snapshot).filter(([name]) => !name.startsWith("streams/")).reduce((sum, [, file]) => sum + file.size, 0);
  const peak = process.memoryUsage();
  const sampleMemory = () => {
    const value = process.memoryUsage();
    for (const key of Object.keys(peak) as (keyof NodeJS.MemoryUsage)[]) peak[key] = Math.max(peak[key], value[key]);
  };
  const timer = setInterval(sampleMemory, 500).unref();
  const hint: NonNullable<ArchiveBuildState["replayHint"]> = { controls: [] };
  let low = Infinity, high = -Infinity, position = 0, lastProgress = 0;
  const progress = (stage: string, bytes: number, totalBytes: number) => {
    sampleMemory();
    send({ type: "progress", value: { stage, bytes, totalBytes, eventPosition: position,
      elapsedMs: performance.now() - begin, memory: peak, replayHint: hint } });
  };
  try {
    const run = await createRunReducer(index, { cold: true, signal: abort.signal });
    const activity = await createActivityReducer(index, { cold: true, signal: abort.signal,
      streamLimits: new Map(Object.entries(source.snapshot).filter(([name]) => name.startsWith("streams/")).map(([name, state]) => [name, state.size])) });
    progress("events", 0, totalEventBytes);
    const eventStart = performance.now();
    const events = await index.bulkEvents({ signal: abort.signal,
      onEvent: async (event, current) => {
        position = current;
        const time = Date.parse(event.origin?.at ?? event.at);
        if (Number.isFinite(time)) {
          low = Math.min(low, time); high = Math.max(high, time);
          hint.startAt = new Date(low).toISOString(); hint.endAt = new Date(high).toISOString();
        }
        if (event.type === "control") {
          hint.controls.push({ position, epoch: event.trace?.epoch, at: event.origin?.at ?? event.at, mode: event.data.mode });
          progress("events", index.progress.bytes, totalEventBytes);
        }
        await run.feed({ event, position }); await activity.feed({ event, position });
      },
      onProgress: value => { if (value.complete || performance.now() - lastProgress > 200) {
        lastProgress = performance.now(); progress("events", value.bytes, value.totalBytes);
      } },
    });
    const scanMs = performance.now() - eventStart;
    progress("projections", events.bytes, events.totalBytes);
    const projectionStart = performance.now();
    await run.finish(); await activity.finish();
    const projectionMs = performance.now() - projectionStart;
    progress("operations", events.bytes, events.totalBytes);
    const operationStart = performance.now();
    await refreshOperationIndex(index, { signal: abort.signal });
    const operationMs = performance.now() - operationStart;
    progress("write", events.bytes, events.totalBytes);
    const writeStart = performance.now();
    await index.finishBulk();
    index.setMeta("cold:ready", "1"); index.flush();
    const writeMs = performance.now() - writeStart;
    await verifySources(request.path, source, abort.signal);
    abort.signal.throwIfAborted(); sampleMemory();
    index.close();
    const reply: BuilderReply = { type: "done", source, value: { bytes: events.bytes, totalBytes: events.totalBytes, eventPosition: position,
      elapsedMs: performance.now() - begin, memory: peak, replayHint: hint,
      metrics: { scanMs, projectionMs, operationMs, writeMs, ...storageMetrics } } };
    await new Promise<void>((resolve, reject) => process.send!(reply, error => error ? reject(error) : resolve()));
  } finally { clearInterval(timer); }
}
