import type { ReplayEvidenceSelection } from "./replay-evidence-model";

/** Elapsed seconds, mm:ss, or hh:mm:ss; the last field may include milliseconds. */
export function parseReplayElapsed(input: string): number | null {
  const value = input.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  const milliseconds = Math.round(parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

export function replayElapsedInput(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

export function replayEvidenceFromSearch(search: string): ReplayEvidenceSelection | null {
  const query = new URLSearchParams(search);
  const item = query.get("replayItem"), record = query.get("replayRecord"), sequence = query.get("replaySequence");
  // Conflicting or malformed references remain visible as an unavailable selection,
  // rather than silently changing which evidence a shared link identifies.
  if (item !== null) return { kind: "item", id: record !== null || sequence !== null ? "" : item };
  if (record !== null || sequence !== null) return { kind: "frame", record: record ?? "",
    sequence: sequence && /^\d+$/.test(sequence) && Number.isSafeInteger(Number(sequence)) ? Number(sequence) : 0 };
  return null;
}

export function replayEvidencePatch(selection: ReplayEvidenceSelection | null): Record<string, string | null> {
  return { replayItem: selection?.kind === "item" ? selection.id : null,
    replayRecord: selection?.kind === "frame" ? selection.record : null,
    replaySequence: selection?.kind === "frame" ? String(selection.sequence) : null };
}

export function replayEvidenceKey(selection: ReplayEvidenceSelection | null) {
  return selection ? JSON.stringify(selection) : "";
}
