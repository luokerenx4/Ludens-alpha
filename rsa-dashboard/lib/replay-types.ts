/** Read-only projection of the workspace's existing records onto UTC milliseconds. */
import type { RunData } from "./types";
export type ReplayTrack = "action" | "model" | "tool" | "log";

export interface ReplayOverview {
  project: string;
  run: string;
  epoch: string | null;
  cycles: RunData["cycles"];
  startAt: number;
  endAt: number;
  capabilities: string[];
  coverage?: ReplayCoverage;
}

export interface ReplayCoverage { bytes: number; totalBytes: number; complete: boolean; throughAt?: number }
export interface ReplayPreparing {
  project: string; run: string; epoch: string | null; startAt: null; endAt: null;
  cycles: RunData["cycles"]; capabilities: string[]; coverage: ReplayCoverage;
}
export type ReplayOverviewResult = ReplayOverview | ReplayPreparing;

export interface ReplayFrame {
  id: string;
  sequence: number;
  at: number;
  capability: string;
  text?: string;
  media: { index: number; mediaType: string; url: string; video?: {
    /** Resource identity is stable even when a different recorded frame authorizes its URL. */
    assetId: string;
    url: string;
    originAt: number;
    width: number;
    height: number;
    durationSeconds: number;
    status: "pending" | "ready" | "error" | "gap";
    reason?: string;
  } }[];
}

export interface ReplayItem {
  id: string;
  track: ReplayTrack;
  startAt: number;
  endAt: number | null;
  label: string;
  status?: string;
  source: { seq: number; modelCallId?: string; toolCallId?: string; actionId?: string; traceId?: string };
}

export interface ReplayWindow {
  startAt: number;
  endAt: number;
  frames: ReplayFrame[];
  items: ReplayItem[];
  nextCursor?: string;
  coverage?: ReplayCoverage;
}

export interface ReplayDetail {
  title: string;
  data: unknown;
  /** Exact known model inputs; never inferred from the nearest frame. */
  observations?: { id: string; url?: string; recordId?: string; sequence?: number; approximate?: boolean }[];
}

// GET /api/replay?project=&run=&epoch=&mode=overview|frames|events|detail|media|segment
// frames/events have independent cursors and return only their own track in ReplayWindow.
// detail: id = ReplayItem.id, or record=ReplayFrame.id&sequence=.
// media: record=&sequence=&media=<index>; image bytes, no caller-supplied file path.
// segment: record=&sequence=&media=; one original record authorizes the streamed video.
// Errors: { error: string }. All responses and controls are read-only.
