import { mkdirSync, openSync, closeSync, writeSync, existsSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Event } from "./types";

const FORMAT = "files-3";
const CHUNK = 1024 * 1024;
export type FileState = { path: string; identity: string; size: number; mtime: number; offset: number; head: string; tail: string };
export { FileRecords, SourceChanged } from "./record-store";
export type { RecordPointer } from "./record-store";
import { FileRecords, SourceChanged, recordCacheStats, type RecordPointer } from "./record-store";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export type IndexBatch = { maxBytes?: number; signal?: AbortSignal };
export type EventProgress = { bytes: number; totalBytes: number; eventPosition: number; complete: boolean };
export type EventRef = RecordPointer & { position: number; seq: number; at: string; timeMs: number; type: string;
  epoch: string | null; model: string | null; offset: number; length: number; traceId?: string; spanId?: string;
  parentSpanId?: string; toolCallId?: string; operationId?: string };
export type EventQuery = { afterPosition?: number; beforePosition?: number; reverse?: boolean; limit?: number;
  epoch?: string | null; model?: string; traceId?: string; spanId?: string; types?: string[];
  fromAt?: string | number; toAt?: string | number; toolCallId?: string; actionId?: string; resultId?: string;
  observationId?: string; signal?: AbortSignal };
export const positionKey = (position: number) => String(position).padStart(16, "0");
const relationKey = (relation: unknown[], position?: number) => JSON.stringify(relation) + ":" + (position === undefined ? "" : positionKey(position));
function timeValue(value?: string | number) {
  const time = typeof value === "string" ? Date.parse(value) : value;
  if (time !== undefined && !Number.isFinite(time)) throw new Error("无效的事件时间");
  return time;
}
function queryRelations(options: EventQuery): unknown[][] {
  const result: unknown[][] = [];
  if (options.model) result.push(["model", options.model]);
  if (options.traceId && options.spanId) result.push(["span", options.traceId, options.spanId]);
  else if (options.traceId) result.push(["trace", options.traceId]);
  for (const name of ["toolCallId", "actionId", "resultId", "observationId"] as const)
    if (options[name]) result.push([name, options[name]]);
  return result;
}
function eventRelations(event: Event): unknown[][] {
  const trace = event.trace ?? {}, data = event.data ?? {}, relations = queryRelations({ model: trace.modelCallId,
    traceId: trace.traceId, spanId: trace.spanId, toolCallId: trace.toolCallId });
  if (trace.traceId && trace.spanId) relations.push(["trace", trace.traceId]);
  if (typeof data.actionId === "string") relations.push(["actionId", data.actionId]);
  if (event.type === "execution" && typeof data.id === "string") relations.push(["resultId", data.id]);
  if (data.result?.id) relations.push(["resultId", data.result.id]);
  const ids = new Set<string>();
  if (typeof data.observationId === "string") ids.add(data.observationId);
  if (event.type === "observation" && typeof data.id === "string") ids.add(data.id);
  const observations = [...(data.observations ?? []), ...(data.result?.observations ?? []),
    ...(data.records ?? []).flatMap((record: any) => record.observations ?? [])];
  for (const value of observations) if (typeof value === "string") ids.add(value); else if (value?.id) ids.add(value.id);
  for (const id of ids) relations.push(["observationId", id]);
  return relations;
}

/** Disposable file index: raw JSONL is authoritative and remains unmodified. */
export class LogIndex {
  private pending?: Promise<void>;
  private refreshing?: { promise: Promise<EventProgress>; controller: AbortController; subscribers: number };
  private stores = new Map<string, FileRecords>();
  private metadata: Record<string, string> = {};
  private files: Record<string, FileState> = {};
  private eventPosition = 0;
  private dirty = false;
  // Set by loadRun from the project registry; null disallows workspace archives.
  archiveWorkspace?: string | null;
  leases = 0;
  lastUsed = Date.now();
  retain() { this.leases++; this.lastUsed = Date.now(); let done = false; return () => { if (!done) { done = true; this.leases--; this.lastUsed = Date.now(); } }; }
  constructor(readonly path: string, readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    const checkpoint = join(directory, "checkpoint.json");
    if (existsSync(checkpoint)) {
      const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
      this.metadata = saved.metadata; this.files = saved.files;
    }
    // An interrupted projection is rebuilt rather than exposing a half-committed cursor.
    if (this.metadata.format !== FORMAT || existsSync(join(directory, ".writing"))) this.reset();
    this.eventPosition = Number(this.metadata.eventPosition ?? 0);
  }
  store(name: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("无效的索引文件名");
    let store = this.stores.get(name);
    if (!store) {
      store = new FileRecords(join(this.directory, name), () => this.markDirty(), name === "blocks", name === "events" ? join(this.path, "events.jsonl") : undefined);
      this.stores.set(name, store);
    }
    return store;
  }
  meta(key: string) { return this.metadata[key]; }
  private markDirty() {
    if (this.dirty) return;
    closeSync(openSync(join(this.directory, ".writing"), "w")); this.dirty = true;
  }
  setMeta(key: string, value: string | number) {
    if (this.metadata[key] !== String(value)) { this.markDirty(); this.metadata[key] = String(value); }
  }
  get generation() { return this.metadata.generation; }
  get revision() { return Number(this.metadata.revision ?? 0); }
  get eventRevision() { return this.eventPosition; }
  get timeBounds(): { startAt?: string; endAt?: string } {
    // Existing files-3 directories already have per-page time summaries. They
    // can be opened without rebuilding or scanning the raw event history.
    const fallback = this.metadata["source:minTime"] === undefined ? this.store("events").timeBounds : undefined;
    const min = fallback?.min ?? Number(this.metadata["source:minTime"]);
    const max = fallback?.max ?? Number(this.metadata["source:maxTime"]);
    return { ...(Number.isFinite(min) ? { startAt: new Date(min).toISOString() } : {}),
      ...(Number.isFinite(max) ? { endAt: new Date(max).toISOString() } : {}) };
  }
  reset() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    rmSync(this.directory, { recursive: true, force: true }); mkdirSync(this.directory, { recursive: true });
    this.metadata = { format: FORMAT, generation: randomUUID(), revision: "0", eventPosition: "0" };
    this.files = {}; this.eventPosition = 0; this.dirty = false; this.markDirty();
  }
  /** Drop only named derived tables; raw logs and other projections stay intact. */
  resetStores(names: readonly string[]) {
    for (const name of names) if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("无效的索引文件名");
    this.markDirty();
    for (const name of names) {
      this.stores.get(name)?.close(); this.stores.delete(name);
      rmSync(join(this.directory, name), { recursive: true, force: true });
    }
  }
  /** Re-project presentation while retaining raw-event pointers, images and other readers' caches. */
  resetActivity() {
    this.resetStores(["blocks", "streams", "python-groups", "payloads"]);
    for (const key of Object.keys(this.metadata))
      if (key.startsWith("activity") || key.startsWith("current:") || key.startsWith("latest:")) delete this.metadata[key];
    for (const file of Object.keys(this.files)) if (file.startsWith("streams/")) delete this.files[file];
    this.metadata.activityGeneration = randomUUID(); this.metadata.revision = "0";
  }
  flush() {
    for (const store of this.stores.values()) store.flush();
    if (!this.dirty) return;
    const checkpoint = join(this.directory, "checkpoint.json");
    const fd = openSync(checkpoint + ".tmp", "w");
    try { writeSync(fd, JSON.stringify({ metadata: this.metadata, files: this.files })); }
    finally { closeSync(fd); }
    renameSync(checkpoint + ".tmp", checkpoint);
    rmSync(join(this.directory, ".writing"), { force: true }); this.dirty = false;
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const release = this.retain();
    const result = (this.pending ?? Promise.resolve()).then(async () => {
      try {
        const value = await work();
        await this.flush();
        return value;
      } catch (error) {
        // No mutation journal/transactions: failed cache work is simply reconstructible.
        if (this.dirty) { if ((error as Error).name !== "AbortError") this.reset(); await this.flush(); }
        throw error;
      }
    });
    void result.finally(release).catch(() => {});
    const tail = result.then(() => {}, () => {});
    this.pending = tail;
    void tail.then(() => { if (this.pending === tail) this.pending = undefined; });
    return result;
  }
  async readAppend(relative: string, maxBytes = CHUNK): Promise<{ text: string; state: FileState; changed: boolean } | null> {
    const file = join(this.path, relative);
    let info;
    try {
      if (await realpath(file) !== file || !file.startsWith(this.path + "/")) throw new Error("日志文件必须位于运行目录内");
      info = await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const previous = this.files[relative], identity = `${info.dev}:${info.ino}`;
    if (previous && (previous.identity !== identity || info.size < previous.size ||
      (info.size === previous.size && info.mtimeMs !== previous.mtime))) throw new SourceChanged(relative);
    if (previous && previous.size === info.size && previous.mtime === info.mtimeMs && previous.offset === info.size)
      return { text: "", state: previous, changed: false };
    const handle = await open(file, "r");
    try {
      const slice = async (position: number, size: number) => {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, position);
        return buffer.subarray(0, bytesRead);
      };
      const offset = previous?.offset ?? 0;
      if (previous && offset && (digest(await slice(0, Math.min(offset, 4096))) !== previous.head ||
        digest(await slice(Math.max(0, offset - 256), Math.min(offset, 256))) !== previous.tail)) throw new SourceChanged(relative);
      let incoming = await slice(offset, Math.min(Math.max(1, maxBytes), CHUNK, info.size - offset));
      // One exceptionally long JSON value is indivisible, but unrelated history stays on disk.
      while (!incoming.includes(10) && offset + incoming.length < info.size)
        incoming = Buffer.concat([incoming, await slice(offset + incoming.length, Math.min(Math.max(1, maxBytes), CHUNK, info.size - offset - incoming.length))]);
      const complete = incoming.lastIndexOf(10) + 1;
      const nextOffset = offset + complete;
      const state = { path: relative, identity, size: info.size, mtime: info.mtimeMs, offset: nextOffset,
        head: digest(await slice(0, Math.min(nextOffset, 4096))),
        tail: digest(await slice(Math.max(0, nextOffset - 256), Math.min(nextOffset, 256))) };
      return { text: incoming.subarray(0, complete).toString("utf8"), state, changed: complete > 0 };
    } finally { await handle.close(); }
  }
  saveFile(state: FileState) {
    if (JSON.stringify(this.files[state.path]) !== JSON.stringify(state)) {
      this.markDirty(); this.files[state.path] = state;
    }
  }
  get progress(): EventProgress {
    const file = this.files["events.jsonl"];
    return { bytes: file?.offset ?? 0, totalBytes: file?.size ?? 0, eventPosition: this.eventPosition,
      complete: !!file && file.offset === file.size };
  }
  async appendEvents(options: IndexBatch = {}): Promise<EventProgress> {
    let consumed = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      let next;
      try { next = await this.readAppend("events.jsonl", Math.min(CHUNK, (options.maxBytes ?? Infinity) - consumed)); }
      catch (error) { if (!(error instanceof SourceChanged)) throw error; this.reset(); next = await this.readAppend("events.jsonl"); }
      if (!next) throw new Error("未找到事件日志");
      if (!next.changed) { this.saveFile(next.state); return this.progress; }
      let offset = next.state.offset - Buffer.byteLength(next.text);
      const store = this.store("events");
      const bounds = this.timeBounds;
      let minTime = bounds.startAt ? Date.parse(bounds.startAt) : Infinity;
      let maxTime = bounds.endAt ? Date.parse(bounds.endAt) : -Infinity;
      for (const line of next.text.split("\n").slice(0, -1)) {
        if (!line) { offset++; continue; }
        const event = JSON.parse(line) as Event;
        const length = Buffer.byteLength(line) + 1, position = ++this.eventPosition;
        const trace = event.trace ?? {}, timeMs = Date.parse(event.origin?.at ?? event.at);
        if (Number.isFinite(timeMs)) { minTime = Math.min(minTime, timeMs); maxTime = Math.max(maxTime, timeMs); }
        store.index(positionKey(position), { position, seq: event.seq, offset, length, timeMs,
          model: trace.modelCallId ?? null, epoch: trace.epoch ?? null, type: event.type, at: event.at,
          ...(trace.traceId ? { traceId: trace.traceId } : {}), ...(trace.spanId ? { spanId: trace.spanId } : {}),
          ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
          ...(trace.toolCallId ? { toolCallId: trace.toolCallId } : {}),
          ...(trace.operationId ? { operationId: trace.operationId } : {}) });
        for (const relation of eventRelations(event)) this.store("relations").index(relationKey(relation, position), { position });
        offset += length;
      }
      consumed += Buffer.byteLength(next.text);
      this.saveFile(next.state); this.setMeta("eventPosition", this.eventPosition);
      if (Number.isFinite(minTime)) this.setMeta("source:minTime", minTime);
      if (Number.isFinite(maxTime)) this.setMeta("source:maxTime", maxTime);
      // A complete source chunk is the commit/cancellation boundary.
      if (next.state.offset === next.state.size || consumed >= (options.maxBytes ?? Infinity)) return this.progress;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async queryEventRefs(options: EventQuery = {}): Promise<EventRef[]> {
    options.signal?.throwIfAborted();
    const found: EventRef[] = [], limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 500) || 500));
    const epoch = options.epoch === "" ? null : options.epoch;
    const store = this.store("events"), relations = queryRelations(options);
    const time = { from: timeValue(options.fromAt), to: timeValue(options.toAt) };
    const candidates = relations.length ? this.store("relations").entries({ prefix: relationKey(relations[0]), reverse: options.reverse })
      : store.entries({ afterId: positionKey(options.afterPosition ?? 0),
        ...(options.beforePosition !== undefined ? { beforeId: positionKey(options.beforePosition) } : {}),
        reverse: options.reverse, where: { ...(epoch !== undefined ? { epoch } : {}),
          ...(options.types?.length === 1 ? { type: options.types[0] } : {}) },
        ...(options.fromAt !== undefined || options.toAt !== undefined ? { time } : {}) });
    let examined = 0;
    for (const candidate of candidates) {
      if (++examined % 250 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); options.signal?.throwIfAborted(); }
      const entry = (relations.length ? store.meta(positionKey(candidate.position)) : candidate) as EventRef | undefined;
      if (!entry || entry.position <= (options.afterPosition ?? 0) || entry.position >= (options.beforePosition ?? Infinity)
        || (epoch !== undefined && (entry.epoch ?? null) !== epoch)
        || (time.from !== undefined && entry.timeMs < time.from) || (time.to !== undefined && entry.timeMs > time.to)
        || (options.types && !options.types.includes(entry.type))
        || relations.slice(1).some(relation => !this.store("relations").meta(relationKey(relation, entry.position)))) continue;
      found.push(entry); if (found.length >= limit) break;
    }
    options.signal?.throwIfAborted(); return found;
  }
  async readEvent(value: number | EventRef): Promise<Event | undefined> {
    const ref = typeof value === "number" ? this.store("events").meta(positionKey(value)) : value;
    return ref ? this.store("events").read<Event>(ref) : undefined;
  }
  async queryEvents(options: EventQuery = {}) {
    const refs = await this.queryEventRefs(options);
    return Promise.all(refs.map(async ref => ({ position: ref.position, event: (await this.readEvent(ref))! })));
  }
  refreshEvents(options: IndexBatch = {}): Promise<EventProgress> {
    options.signal?.throwIfAborted();
    if (!this.refreshing || (this.refreshing.controller.signal.aborted && !this.refreshing.subscribers)) {
      const controller = new AbortController();
      const task = { controller, subscribers: 0, promise: undefined as unknown as Promise<EventProgress> };
      this.refreshing = task;
      task.promise = this.exclusive(() => this.appendEvents({ maxBytes: options.maxBytes, signal: controller.signal }))
        .finally(() => { if (this.refreshing === task) this.refreshing = undefined; });
    }
    const task = this.refreshing; task.subscribers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const release = () => {
        if (done) return false;
        done = true; options.signal?.removeEventListener("abort", abort);
        if (--task.subscribers === 0) task.controller.abort();
        return true;
      };
      const abort = () => { if (release()) reject(options.signal!.reason); };
      options.signal?.addEventListener("abort", abort, { once: true });
      task.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
    });
  }
  async drain() {
    do {
      await this.pending;
      // Let a cancelled preparation's queued continuation unwind too, before
      // closing handles. Its outer HTTP waiter may already have departed.
      await new Promise<void>(resolve => setImmediate(resolve));
    } while (this.pending);
  }
  close() { this.flush(); for (const store of this.stores.values()) store.close(); this.stores.clear(); }
}

const registryKey = Symbol.for("ludens.dashboard.paged-file-index");
const registry = ((globalThis as any)[registryKey] ??= new Map<string, LogIndex>()) as Map<string, LogIndex>;
export function pruneLogIndexes(now = Date.now()) {
  const max = Math.max(1, Number(process.env.RSA_DASHBOARD_INDEX_MAX_RUNS) || 3);
  const idle = Math.max(1, Number(process.env.RSA_DASHBOARD_INDEX_IDLE_MS) || 300_000);
  for (const [path, index] of [...registry].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
    if (index.leases || (registry.size <= max && now - index.lastUsed < idle)) continue;
    index.close(); registry.delete(path);
  }
}
export function indexCacheStats() { return { runs: registry.size, leased: [...registry.values()].filter(i => i.leases).length, ...recordCacheStats() }; }
// Idle runs are reclaimed even when there is no subsequent HTTP request.
const timerKey = Symbol.for("ludens.dashboard.paged-file-index.timer");
if (!(globalThis as any)[timerKey]) (globalThis as any)[timerKey] = setInterval(() => pruneLogIndexes(), 30_000).unref();
export function getLogIndex(path: string): LogIndex {
  let index = registry.get(path);
  if (!index) {
    const directory = process.env.RSA_DASHBOARD_INDEX_ROOT ? join(process.env.RSA_DASHBOARD_INDEX_ROOT, path.split("/").at(-1)!) : join(path, ".dashboard-index");
    mkdirSync(directory, { recursive: true });
    if (realpathSync(directory) !== directory) throw new Error("日志索引必须位于运行目录内");
    index = new LogIndex(path, directory); registry.set(path, index);
  }
  index.lastUsed = Date.now();
  const release = index.retain(); pruneLogIndexes(); release();
  return index;
}
export async function loadIndexedEvents(path: string) {
  const index = getLogIndex(path), release = index.retain();
  try {
    await index.refreshEvents();
    return { index, release, generation: index.generation, revision: index.revision, eventRevision: index.eventRevision };
  } catch (error) { release(); throw error; }
}
export async function closeLogIndexes() {
  const entries = [...registry.values()]; registry.clear();
  for (const entry of entries) { await entry.drain(); entry.close(); }
}
