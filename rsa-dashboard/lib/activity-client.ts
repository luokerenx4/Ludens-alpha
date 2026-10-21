/** Shared read-only activity protocol for the Dashboard hook and Alice Pet. */
export interface EventSource { component: string; implementation?: string; implementationVersion?: string }
export interface LogBlock {
  id: string;
  kind: "thinking" | "text" | "tool" | "system" | "diagnostic";
  at: string;
  title: string;
  text: string;
  status: "running" | "complete" | "error";
  tool?: { intent?: string; args?: unknown; result?: unknown };
  data?: Record<string, unknown>;
  source?: EventSource;
  trace?: Record<string, string>;
  eventId?: string;
  seq?: number;
  updatedAt?: string;
}
export interface ActivityBlock extends LogBlock { createdRevision: number; revision: number }
export interface ActivityScope { project: string; runId: string | null; epoch: string | null }
export interface ActivityProjection {
  source: EventSource;
  throughSeq: number;
  latestEventAt: string | null;
  latestSourceAt: string | null;
  generatedAt: string;
  durationMs: number;
  blockCount: number;
  revision: number;
  generation: string;
}
export interface ActivityCurrent {
  workspace: string | null;
  runId: string | null;
  epoch: string | null;
  activity: "running" | "manual" | "offline" | "idle";
  phase: string | null;
  intent: string | null;
  observationId: string | null;
  updatedAt: string | null;
  error: string | null;
}
export interface ActivityResponse {
  scope: ActivityScope;
  mode: "snapshot" | "delta" | "history" | "block";
  blocks: ActivityBlock[];
  cursor?: string | null;
  before?: string | null;
  hasMore: boolean;
  total?: number;
  projection: ActivityProjection;
  current: ActivityCurrent;
}
export interface ActivityChanges extends ActivityResponse {
  mode: "snapshot" | "delta";
  cursor: string | null;
}
export interface ActivityChangesPage extends ActivityChanges {
  /** Call only after the consumer has accepted the blocks into its bounded state or queue. */
  acknowledge(): void;
}
export function sameScope(left: ActivityScope | null, right: ActivityScope | null): boolean {
  return left?.project === right?.project && left?.runId === right?.runId && left?.epoch === right?.epoch;
}
export function acceptsScope(scope: ActivityScope, project: string, run?: string, epoch?: string): boolean {
  return scope.project === project && (run === undefined || scope.runId === run)
    && (epoch === undefined || scope.epoch === epoch);
}
export async function requestActivity(params: URLSearchParams, signal: AbortSignal, baseUrl?: string): Promise<ActivityResponse> {
  const path = "/api/activity?" + params;
  const response = await fetch(baseUrl ? new URL(path, baseUrl).href : path, { cache: "no-store", signal });
  const result = await response.json();
  signal.throwIfAborted();
  if (!response.ok) throw new Error(result.error ?? `日志服务 HTTP ${response.status}`);
  return result;
}

/** Holds only an opaque cursor. The server owns projection, ordering and reset snapshots. */
export class ActivityChangesClient {
  private cursor: string | null = null;
  constructor(private options: { project: string; run?: string; epoch?: string; limit?: number; baseUrl?: string }) {}

  async read(signal: AbortSignal): Promise<ActivityChangesPage> {
    signal.throwIfAborted();
    const { project, run, epoch, limit, baseUrl } = this.options;
    const previousCursor = this.cursor;
    const params = new URLSearchParams({ project, mode: "changes" });
    if (run !== undefined) params.set("run", run);
    if (epoch !== undefined) params.set("epoch", epoch);
    if (limit !== undefined) params.set("limit", String(limit));
    if (previousCursor) params.set("cursor", previousCursor);
    const result = await requestActivity(params, signal, baseUrl);
    if (!acceptsScope(result.scope, project, run, epoch)) throw new Error("日志返回了其他运行范围");
    if (result.mode !== "snapshot" && result.mode !== "delta") throw new Error("日志返回了非增量页面");
    const cursor = result.cursor ?? null;
    return { ...result, mode: result.mode, cursor, acknowledge: () => {
      if (!signal.aborted && this.cursor === previousCursor) this.cursor = cursor;
    } };
  }
}
