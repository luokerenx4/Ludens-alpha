/** Read-only projection of the workspace's existing records onto UTC milliseconds. */
export type ReplayTrack = "action" | "model" | "tool" | "log";

export interface ReplayOverview {
  project: string;
  run: string;
  epoch: string | null;
  startAt: number;
  endAt: number;
  capabilities: string[];
}

export interface ReplayFrame {
  id: string;
  sequence: number;
  at: number;
  capability: string;
  text?: string;
  media: { index: number; mediaType: string; url: string }[];
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
}

export interface ReplayDetail {
  title: string;
  data: unknown;
  /** Exact known model inputs; never inferred from the nearest frame. */
  observations?: { id: string; url?: string; recordId?: string; sequence?: number }[];
}

// GET /api/replay?project=&run=&epoch=&mode=overview|window|detail|media
// window: start/end = UTC ms, cursor optional; returns ReplayWindow.
// detail: id = ReplayItem.id, or record=ReplayFrame.id&sequence=.
// media: record=&sequence=&media=<index>; image bytes, no caller-supplied file path.
// Errors: { error: string }. All responses and controls are read-only.
