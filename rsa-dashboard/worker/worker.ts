import { parentPort } from "node:worker_threads";
import { archiveBuild, catalog, getRun, mediaFile, stopRun, timelineRecord } from "../lib/data";
import { diagnosticEvents } from "../lib/diagnostic-events";
import { getActivity } from "../lib/activity";
import { getReplay } from "../lib/replay";
import { benchmarkAttachment, benchmarkCatalog, benchmarkEvidence } from "../lib/benchmark-data";
import { capabilities } from "../lib/capabilities";
import { docGroups, readDoc } from "../lib/docs";
import { aliceState, setAliceTarget, recordAliceConsumer } from "../lib/alice-state";
import { closeLogIndexes, indexCacheStats } from "../lib/log-index";
import { workerFailure, type DashboardMethods, type DashboardMethod, type WorkerRequest, type WorkerResponse } from "../lib/dashboard-protocol";
import { closeArchiveBuilds } from "../lib/cold-build";
const port = parentPort!;
const handlers: { [K in DashboardMethod]: (args: DashboardMethods[K]["args"], signal: AbortSignal) => unknown } = {
  diagnosticEvents: ([project, run, query], signal) => diagnosticEvents(project, run, query, signal),
  diagnostics: () => ({ memory: process.memoryUsage(), index: indexCacheStats(), activeRequests: requests.size - 1 }),
  catalog: () => catalog(),
  archiveBuild: ([project, run, action, buildId]) => archiveBuild(project, run, action, buildId),
  run: ([project, run, epoch, page], signal) => getRun(project, run, epoch, page, signal),
  activity: ([project, run, epoch, query], signal) => getActivity(project, run, epoch, query, signal),
  replay: ([project, run, query], signal) => getReplay(project, run, query, undefined, signal),
  media: ([project, run, id], signal) => mediaFile(project, run, id, undefined, signal),
  timelineRecord: ([project, run, record, sequence, source], signal) => timelineRecord(project, run, record, sequence, source, undefined, signal),
  benchmarkCatalog: ([query]) => benchmarkCatalog(query),
  benchmarkEvidence: ([project, run, query], signal) => benchmarkEvidence(project, run, query, undefined, signal),
  benchmarkAttachment: ([project, run, index, verification], signal) => benchmarkAttachment(project, run, index, verification, undefined, signal),
  capabilities: ([project]) => capabilities(project),
  docGroups: () => docGroups(),
  readDoc: ([id]) => readDoc(id),
  stop: ([project, run, epoch]) => stopRun(project, run, epoch),
  aliceState: () => aliceState(),
  aliceTarget: ([project, ifUnset]) => setAliceTarget(project, ifUnset),
  aliceConsumer: ([input]) => recordAliceConsumer(input),
};
const requests = new Map<number, { abort: AbortController; work: Promise<void> }>();
let closing = false;
port.on("message", (message: WorkerRequest) => {
  if (message.type === "cancel") { requests.get(message.id)?.abort.abort(); return; }
  if (message.type === "close") {
    closing = true;
    for (const request of requests.values()) request.abort.abort();
    void Promise.allSettled([...requests.values()].map(request => request.work)).then(async () => {
      await closeArchiveBuilds(); await closeLogIndexes(); port.close();
    });
    return;
  }
  if (closing) return;
  if (requests.size >= 64) {
    port.postMessage({ type: "error", id: message.id, error: workerFailure(Object.assign(new Error("Dashboard reader is busy; retry shortly"), { status: 503 })) } satisfies WorkerResponse);
    return;
  }
  const abort = new AbortController();
  const work = Promise.resolve().then(async () => {
    try {
      if (!Object.hasOwn(handlers, message.method)) throw new Error("Unknown Dashboard operation");
      abort.signal.throwIfAborted();
      const value = await (handlers[message.method] as (args: unknown[], signal: AbortSignal) => unknown)(message.args, abort.signal);
      abort.signal.throwIfAborted();
      port.postMessage({ type: "result", id: message.id, value } satisfies WorkerResponse);
    } catch (error) {
      if (!abort.signal.aborted) port.postMessage({ type: "error", id: message.id, error: workerFailure(error) } satisfies WorkerResponse);
    } finally { requests.delete(message.id); }
  });
  requests.set(message.id, { abort, work });
});
port.postMessage({ type: "ready" } satisfies WorkerResponse);
