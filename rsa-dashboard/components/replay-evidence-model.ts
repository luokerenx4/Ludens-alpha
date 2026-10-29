export type ReplayEvidenceSelection =
  | { kind: "frame"; record: string; sequence: number }
  | { kind: "item"; id: string };

export function replayEvidenceUrl(scope: string, selection: ReplayEvidenceSelection): string {
  const query = new URLSearchParams(scope);
  for (const key of ["mode", "id", "record", "sequence"]) query.delete(key);
  query.set("mode", "detail");
  if (selection.kind === "frame") {
    query.set("record", selection.record);
    query.set("sequence", String(selection.sequence));
  } else query.set("id", selection.id);
  return `/api/replay?${query}`;
}
