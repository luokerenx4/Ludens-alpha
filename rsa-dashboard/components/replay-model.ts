import type { ReplayFrame, ReplayItem, ReplayOverview, ReplayWindow } from "../lib/replay-types";

export const REPLAY_WINDOW_MS = 30_000;
export const replayTracks = ["action", "model", "tool", "log"] as const;
export const replayTrackLabels = { action: "动作", model: "模型", tool: "工具", log: "日志" };

export function clampReplayTime(at: number, range: Pick<ReplayOverview, "startAt" | "endAt">) {
  return Math.max(range.startAt, Math.min(range.endAt, Number.isFinite(at) ? at : range.startAt));
}

export function replayWindowBounds(at: number, range: Pick<ReplayOverview, "startAt" | "endAt">, windowMs = REPLAY_WINDOW_MS) {
  const position = clampReplayTime(at, range);
  const index = Math.floor(Math.max(0, Math.min(position, range.endAt - 1) - range.startAt) / windowMs);
  const startAt = range.startAt + index * windowMs;
  return { startAt, endAt: Math.min(range.endAt, startAt + windowMs) };
}

export function mergeReplayPages(pages: ReplayWindow[]): ReplayWindow {
  const frames = new Map<string, ReplayFrame>(), items = new Map<string, ReplayItem>();
  for (const page of pages) {
    for (const frame of page.frames) frames.set(frame.id, frame);
    for (const item of page.items) items.set(item.id, item);
  }
  return { startAt: pages[0]?.startAt ?? 0, endAt: pages[0]?.endAt ?? 0,
    frames: [...frames.values()].sort((a, b) => a.at - b.at || a.sequence - b.sequence),
    items: [...items.values()].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)),
    ...(pages.at(-1)?.nextCursor ? { nextCursor: pages.at(-1)!.nextCursor } : {}),
    ...(pages.at(-1)?.coverage ? { coverage: pages.at(-1)!.coverage } : {}) };
}

/** One current frame per capability; never replace missing history with future pixels. */
export function replayFramesAt(frames: ReplayFrame[], at: number, capability = "") {
  const latest = new Map<string, ReplayFrame>();
  for (const frame of frames) {
    if (frame.at > at || (capability && frame.capability !== capability)) continue;
    const previous = latest.get(frame.capability);
    if (!previous || frame.at > previous.at || (frame.at === previous.at && frame.sequence > previous.sequence))
      latest.set(frame.capability, frame);
  }
  return [...latest.values()].sort((a, b) => a.capability.localeCompare(b.capability));
}

export function adjacentReplayFrame(frames: ReplayFrame[], at: number, direction: -1 | 1, capability = "") {
  let closest: ReplayFrame | undefined;
  for (const frame of frames) {
    if ((capability && frame.capability !== capability) || (direction === 1 ? frame.at <= at : frame.at >= at)) continue;
    if (!closest || (direction === 1 ? frame.at < closest.at : frame.at > closest.at)) closest = frame;
  }
  return closest;
}

export function replayItemActive(item: ReplayItem, at: number) {
  return item.startAt <= at && (item.endAt === null || at <= item.endAt);
}

export function nearbyReplayItems(items: ReplayItem[], at: number, limit = 10) {
  return [...items].sort((a, b) => Math.abs(a.startAt - at) - Math.abs(b.startAt - at))
    .slice(0, limit).sort((a, b) => a.startAt - b.startAt);
}

export function replayDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  return [hours ? String(hours) : null, String(Math.floor(seconds / 60) % 60).padStart(2, "0"),
    String(seconds % 60).padStart(2, "0")].filter(value => value !== null).join(":");
}

export function retainReplayWindows(windows: ReplayWindow[], currentStart: number) {
  return [...new Map(windows.map(window => [window.startAt, window])).values()]
    .sort((a, b) => Math.abs(a.startAt - currentStart) - Math.abs(b.startAt - currentStart) || b.startAt - a.startAt)
    .slice(0, 2);
}
