import { resolveRun, globalHome } from "./data";
import { getDiagnosticIndex, type EventQuery } from "./log-index";

export type DiagnosticQuery = Pick<EventQuery, "afterPosition" | "limit" | "epoch" | "fromAt" | "toAt" | "traceId" | "spanId" | "actionId" | "observationId">;

/** Bounded explicit reads; optional full traces never enter activity/replay or Pet. */
export async function diagnosticEvents(project: string, run: string, query: DiagnosticQuery = {}, signal?: AbortSignal, root = globalHome) {
  const path = await resolveRun(project, run, root), index = getDiagnosticIndex(path), release = index.retain();
  try {
    const progress = await index.refreshEvents({ maxBytes: 4 * 1024 * 1024, signal });
    const events = await index.queryEvents({ ...query, limit: Math.min(query.limit ?? 100, 500), signal });
    return { events, nextAfter: events.at(-1)?.position ?? query.afterPosition ?? 0, progress };
  } finally { release(); }
}
