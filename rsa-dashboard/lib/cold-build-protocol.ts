import type { SourceDependency } from "../../shared/event-sources";
export type SourceSnapshot = Record<string, { identity: string; size: number; mtime: number;
  source?: { path: string; sourceId: string; dependency: SourceDependency } }>;

export interface ArchiveBuildState {
  id: string;
  state: "queued" | "building" | "ready" | "cancelled" | "failed";
  stage?: string;
  bytes?: number;
  totalBytes?: number;
  eventPosition?: number;
  error?: string;
  generation?: string;
  pid?: number;
  elapsedMs?: number;
  memory?: NodeJS.MemoryUsage;
  metrics?: Record<string, unknown>;
  replayHint?: { startAt?: string; endAt?: string; controls: { position: number; epoch?: string; at: string; mode: unknown }[] };
}
export interface CapturedSource { snapshot: SourceSnapshot; checks: Record<string, { sourceSize: number; head: string; tail: string }> }
export type BuilderRequest = { type: "build"; id: string; path: string; directory: string; workspace?: string | null; budgetBytes: number }
  | { type: "cancel" };
export type BuilderReply = { type: "progress"; value: Partial<ArchiveBuildState> }
  | { type: "done"; source: CapturedSource; value: Partial<ArchiveBuildState> }
  | { type: "error"; message: string; code?: string };
