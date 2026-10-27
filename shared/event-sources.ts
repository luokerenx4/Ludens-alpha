/** Local, explicitly registered device archives. Ranges locate data; they do not own it. */
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type EventChannel = "events" | "diagnostics";
export interface EventSourceDescriptor { sourceId: string; root: string; format: "baseware-events-v1" }
export interface SourceDependency extends EventSourceDescriptor {
  recordingId: string;
  windows: { afterSeq: number; throughSeq?: number }[];
}
export interface EventSegment {
  sourceId: string; channel: EventChannel; firstSeq: number; lastSeq: number; count: number; bytes: number;
  recordings: Record<string, { firstSeq: number; lastSeq: number }>;
  unowned?: { firstSeq: number; lastSeq: number };
}
export interface EventSourceFile {
  name: string; path: string; sourceId: string; dependency: SourceDependency; channel: EventChannel; size: number;
}
type SourceEvent = { serviceId?: string; origin?: { clockId?: string; seq?: number }; seq?: number;
  trace?: { recordingId?: unknown } };
const token = /^[a-zA-Z0-9._-]+$/;
const missing = (message: string) => Object.assign(new Error(message), { code: "EVENT_SOURCE_UNAVAILABLE" });

export function matchesSourceEvent(event: SourceEvent, dependency: SourceDependency) {
  if ((event.origin?.clockId ?? event.serviceId) !== dependency.sourceId) return false;
  const recordingId = event.trace?.recordingId;
  if (typeof recordingId === "string") return recordingId === dependency.recordingId;
  const seq = event.origin?.seq ?? event.seq;
  // Unowned background has a confirmed observation horizon, never an open-ended run lifetime.
  return Number.isSafeInteger(seq) && dependency.windows.some(window => window.throughSeq !== undefined
    && seq! > window.afterSeq && seq! <= window.throughSeq);
}

export async function listEventSourceFiles(dependency: SourceDependency, channel: EventChannel = "events"): Promise<EventSourceFile[]> {
  if (dependency.format !== "baseware-events-v1" || !token.test(dependency.sourceId)
    || !dependency.recordingId || !Array.isArray(dependency.windows)
    || dependency.windows.some(w => !Number.isSafeInteger(w.afterSeq) || w.afterSeq < 0
      || (w.throughSeq !== undefined && (!Number.isSafeInteger(w.throughSeq) || w.throughSeq < w.afterSeq))))
    throw missing("Invalid registered event source");
  const root = resolve(dependency.root);
  try {
    if (await realpath(root) !== root) throw missing("Event source root changed or contains a symlink");
    const descriptorPath = join(root, "source.json");
    if (await realpath(descriptorPath) !== descriptorPath) throw missing("Event source descriptor contains a symlink");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    if (descriptor.sourceId !== dependency.sourceId || descriptor.format !== dependency.format)
      throw missing("Event source identity changed");
    const directory = join(root, channel);
    if (await realpath(directory) !== directory) throw missing("Event source channel contains a symlink");
    const files: EventSourceFile[] = [];
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".jsonl")).sort()) {
      if (!token.test(name)) throw missing("Invalid event segment name");
      const path = join(directory, name);
      if (await realpath(path) !== path) throw missing("Event segment contains a symlink");
      // Metadata is an optimization only. A crash after append may leave a stale/missing summary.
      const info = await stat(path);
      try {
        const metaPath = path.slice(0, -6) + ".meta.json";
        if (await realpath(metaPath) !== metaPath) throw missing("Event summary contains a symlink");
        const meta: EventSegment = JSON.parse(await readFile(metaPath, "utf8"));
        if (meta.sourceId !== dependency.sourceId || meta.channel !== channel) throw missing("Event segment identity changed");
        if (meta.bytes === info.size && !Object.hasOwn(meta.recordings, dependency.recordingId)
          && !(meta.unowned && dependency.windows.some(w => w.throughSeq !== undefined
            && meta.unowned!.lastSeq > w.afterSeq && meta.unowned!.firstSeq <= w.throughSeq))) continue;
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      files.push({ name: `baseware/${dependency.sourceId}/${channel}/${name}`, path,
        sourceId: dependency.sourceId, dependency, channel, size: info.size });
    }
    return files;
  } catch (error) {
    if ((error as { code?: string }).code === "EVENT_SOURCE_UNAVAILABLE") throw error;
    throw missing(`Event source ${dependency.sourceId} is unavailable: ${String(error)}`);
  }
}

/** Stream a fixed file horizon. Only an incomplete final line is skipped, never malformed facts. */
async function* readEventFile(path: string, size: number, signal?: AbortSignal): AsyncGenerator<Record<string, any>> {
  signal?.throwIfAborted();
  if (!size) return;
  const stream = createReadStream(path, { encoding: "utf8", end: size - 1, signal });
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let start = 0, newline: number;
      while ((newline = pending.indexOf("\n", start)) !== -1) {
        signal?.throwIfAborted();
        const line = pending.slice(start, newline);
        start = newline + 1;
        if (line.trim()) yield JSON.parse(line);
      }
      pending = pending.slice(start);
    }
  } finally { stream.destroy(); }
}

/** Merge facts on demand; one open segment/head per source, no synthesized global sequence. */
export async function* readRunEvents(runDir: string, options: { channel?: EventChannel; signal?: AbortSignal } = {}): AsyncGenerator<Record<string, any>> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const channel = options.channel ?? "events";
  let manifest: { eventSources?: SourceDependency[] } = {};
  try { manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), { encoding: "utf8", signal })); }
  catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  const dependencies: SourceDependency[] = manifest.eventSources ?? [];
  if (!Array.isArray(dependencies)) throw missing("Invalid eventSources manifest");
  const sources = await Promise.all(dependencies.map(dependency => listEventSourceFiles(dependency, channel)));
  signal?.throwIfAborted();
  const iterators: AsyncGenerator<Record<string, any>>[] = [];
  const localPath = join(runDir, channel === "events" ? "events.jsonl" : "diagnostics.jsonl");
  try { iterators.push(readEventFile(localPath, (await stat(localPath)).size, signal)); }
  catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  // One source can be declared more than once for separate recording IDs. Read its files once.
  const groups = new Map<string, { files: Map<string, EventSourceFile>; dependencies: SourceDependency[] }>();
  for (const [index, files] of sources.entries()) {
    const dependency = dependencies[index]!;
    const key = JSON.stringify([dependency.sourceId, dependency.root]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { files: new Map(), dependencies: [] });
    group.dependencies.push(dependency);
    for (const file of files) group.files.set(file.name, file);
  }
  for (const group of groups.values()) iterators.push((async function* () {
    for (const file of [...group.files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      for await (const event of readEventFile(file.path, file.size, signal)) {
        signal?.throwIfAborted();
        if (group.dependencies.some(dependency => matchesSourceEvent(event, dependency))) yield event;
      }
    }
  })());
  const timestamp = (event: Record<string, any>) => {
    const value = Date.parse(event.at ?? event.origin?.at);
    return Number.isFinite(value) ? value : 0;
  };
  try {
    const heads = await Promise.all(iterators.map(iterator => iterator.next()));
    while (true) {
      signal?.throwIfAborted();
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        if (!heads[index]!.done && (selected === -1 || timestamp(heads[index]!.value!) < timestamp(heads[selected]!.value!))) selected = index;
      }
      if (selected === -1) break;
      yield heads[selected]!.value!;
      heads[selected] = await iterators[selected]!.next();
    }
  } finally { await Promise.all(iterators.map(iterator => iterator.return(undefined))); }
}
