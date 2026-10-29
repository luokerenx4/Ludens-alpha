import type { LiveStatus } from "./types";

/** The implicit run is a snapshot while paused; explicit navigation starts a new one. */
export interface PausedLiveSelection {
  location: string;
  project: string;
  run: string;
  requestedRun: string;
  epoch: string;
  archiveRevision: number;
}

export function resolveLiveSelection(options: {
  location: string;
  project: string;
  requestedRun: string;
  requestedEpoch: string;
  latestRun: string;
  refresh: boolean;
  archiveRevision: number;
  paused: PausedLiveSelection | null;
}) {
  const { paused } = options;
  const frozen = !options.refresh && paused?.location === options.location;
  return {
    project: frozen ? paused.project : options.project,
    requestedRun: frozen ? paused.requestedRun : options.requestedRun,
    epoch: frozen ? paused.epoch : options.requestedEpoch,
    run: frozen ? paused.run : options.requestedRun || options.latestRun,
    archiveRevision: frozen ? paused.archiveRevision : options.archiveRevision,
    frozen,
  };
}

/** Start from a clean URL so evidence, replay and benchmark parameters cannot leak. */
export function latestLiveUrl(project: string) {
  return "/?" + new URLSearchParams({ view: "live", project });
}

export function hasSelectedEvidence(search: string) {
  const query = new URLSearchParams(search);
  return ["call", "beforeCall", "block", "image", "at"].some(key => query.has(key));
}

export type LiveContextKind = "latest" | "run" | "epoch" | "evidence" | "log";
export type ObservedHost = "auto" | "manual" | "disconnected" | "unavailable" | "historical";

export function liveContext(options: {
  run: string;
  latestRun: string;
  selectedEpoch: string | null;
  latestEpoch: string | null;
  selectedEvidence: boolean;
  historicalLog: boolean;
  live: LiveStatus | null;
}) {
  const oldRun = !!options.latestRun && options.run !== options.latestRun;
  const oldEpoch = !!options.latestEpoch && options.selectedEpoch !== options.latestEpoch;
  const kind: LiveContextKind = oldRun ? "run" : oldEpoch ? "epoch"
    : options.selectedEvidence ? "evidence" : options.historicalLog ? "log" : "latest";
  const live = options.live;
  let host: ObservedHost = "unavailable";
  if (oldRun || oldEpoch) host = "historical";
  else if (live?.runId === options.run) {
    if (!live.connected) host = "disconnected";
    // A returned/manual host may no longer have an active epoch.
    else if (live.mode === "manual") host = "manual";
    else if (live.mode === "auto" && live.epoch === options.selectedEpoch) host = "auto";
  }
  return { kind, host };
}
