import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { listEventSourceFiles, type EventChannel, type EventSourceFile, type SourceDependency } from "../../shared/event-sources";
import { readWorkspaceIdentity } from "../../shared/ludens";
import type { SourceSnapshot } from "./cold-build-protocol";

export type EventFile = { name: string; path: string; sourceId?: string; dependency?: SourceDependency };

/** Only manifest-declared device sources belong to a run. Old runs stay self-contained. */
export async function eventFiles(root: string, channel: EventChannel = "events", snapshot?: SourceSnapshot): Promise<EventFile[]> {
  if (snapshot) return Object.entries(snapshot).filter(([name]) => name === "events.jsonl" || name.startsWith("baseware/"))
    .map(([name, value]) => ({ name, path: value.source?.path ?? join(root, name), ...value.source }));
  let dependencies: SourceDependency[] = [];
  try {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    dependencies = manifest.eventSources ?? [];
    if (!Array.isArray(dependencies)) throw new Error("Invalid run event sources");
    const workspace = dirname(dirname(root));
    const identity = manifest.workspaceId && typeof manifest.workspace === "string" && manifest.workspace !== workspace
      ? await readWorkspaceIdentity(workspace) : undefined;
    if (identity && [identity.id, ...(identity.historyIds ?? [])].includes(manifest.workspaceId)) {
      dependencies = dependencies.map(dependency => {
        const path = relative(manifest.workspace, dependency.root);
        // Only paths recorded inside this workspace move with it. External
        // sources retain their explicit address and fail if unavailable.
        return path && !isAbsolute(path) && path !== ".." && !path.startsWith("../")
          ? { ...dependency, root: resolve(workspace, path) } : dependency;
      });
    }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!Array.isArray(dependencies)) throw new Error("Invalid run event sources");
  const sources: EventSourceFile[] = (await Promise.all(dependencies.map(dependency => listEventSourceFiles(dependency, channel)))).flat();
  const local: EventFile[] = channel === "events" ? [{ name: "events.jsonl", path: join(root, "events.jsonl") }] : [];
  if (channel === "diagnostics") {
    try { await stat(join(root, "diagnostics.jsonl")); local.push({ name: "diagnostics.jsonl", path: join(root, "diagnostics.jsonl") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // A source may only be declared once. Otherwise offsets would lose ownership filtering.
  if (new Set(dependencies.map(source => source.sourceId)).size !== dependencies.length) throw new Error("Duplicate run event source");
  return [...local, ...sources];
}
