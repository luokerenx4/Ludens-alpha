import { mkdirSync, openSync, closeSync, writeSync, existsSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Event } from "./types";

const FORMAT = "files-2";
const CHUNK = 1024 * 1024;
export type FileState = { path: string; identity: string; size: number; mtime: number; offset: number; head: string; tail: string };
export { FileRecords, SourceChanged } from "./record-store";
export type { RecordPointer } from "./record-store";
import { FileRecords, SourceChanged, recordCacheStats, type RecordPointer } from "./record-store";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Disposable file index: raw JSONL is authoritative and remains unmodified. */
export class LogIndex {
  private pending: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> | undefined;
  private stores = new Map<string, FileRecords>();
  private metadata: Record<string, string> = {};
  private files: Record<string, FileState> = {};
  private eventPosition = 0;
  private dirty = false;
  private relationRefresh = new Map<string, Promise<void>>();
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
      store = new FileRecords(join(this.directory, name), () => this.markDirty(), name === "events" || name === "blocks");
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
  reset() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    rmSync(this.directory, { recursive: true, force: true }); mkdirSync(this.directory, { recursive: true });
    this.metadata = { format: FORMAT, generation: randomUUID(), revision: "0", eventPosition: "0" };
    this.files = {}; this.eventPosition = 0; this.relationRefresh.clear(); this.dirty = false; this.markDirty();
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
    const result = this.pending.then(async () => {
      try {
        const value = await work();
        await this.flush();
        return value;
      } catch (error) {
        // No mutation journal/transactions: failed cache work is simply reconstructible.
        if (this.dirty) { this.reset(); await this.flush(); }
        throw error;
      }
    });
    void result.finally(release).catch(() => {});
    this.pending = result.catch(() => {});
    return result;
  }
  async readAppend(relative: string): Promise<{ text: string; state: FileState; changed: boolean } | null> {
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
      let incoming = await slice(offset, Math.min(CHUNK, info.size - offset));
      // One exceptionally long JSON value is indivisible, but unrelated history stays on disk.
      while (!incoming.includes(10) && offset + incoming.length < info.size)
        incoming = Buffer.concat([incoming, await slice(offset + incoming.length, Math.min(CHUNK, info.size - offset - incoming.length))]);
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
  async appendEvents() {
    for (const key of Object.keys(this.metadata).filter(key => key.startsWith("image:")).sort()) {
      await this.store("images").put(key.slice(6), true);
      this.markDirty(); delete this.metadata[key];
    }
    for (;;) {
      let next;
      try { next = await this.readAppend("events.jsonl"); }
      catch (error) { if (!(error instanceof SourceChanged)) throw error; this.reset(); next = await this.readAppend("events.jsonl"); }
      if (!next) throw new Error("未找到事件日志");
      if (!next.changed) { this.saveFile(next.state); return; }
      let offset = next.state.offset - Buffer.byteLength(next.text);
      const store = this.store("events");
      for (const line of next.text.split("\n").slice(0, -1)) {
        if (!line) { offset++; continue; }
        const event = JSON.parse(line) as Event;
        const length = Buffer.byteLength(line) + 1, position = ++this.eventPosition;
        store.reference(String(position), join(this.path, "events.jsonl"), offset, length, {
          position, seq: event.seq, model: event.trace?.modelCallId ?? null, epoch: event.trace?.epoch ?? null,
          type: event.type, at: event.at, traceId: event.trace?.traceId, spanId: event.trace?.spanId, operationId: event.trace?.operationId,
        });
        offset += length;
      }
      this.saveFile(next.state); this.setMeta("eventPosition", this.eventPosition);
      if (next.state.offset === next.state.size) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  private async ensureRelations(kind: "model" | "span") {
    const cursor = `eventRelations:${kind}`;
    if (Number(this.meta(cursor) ?? 0) >= this.eventRevision) return;
    let pending = this.relationRefresh.get(kind);
    if (!pending) {
      const release = this.retain();
      pending = (async () => {
        const after = Number(this.meta(cursor) ?? 0), relations = this.store(`event-${kind}s`);
        let position = after, batch = 0;
        const events = this.store("events");
        function* pointers() {
          for (const entry of events.versions({ after })) {
            position = entry.position;
            const prefix = kind === "model" ? (entry.model ? JSON.stringify(entry.model) : null)
              : (entry.traceId && entry.spanId ? JSON.stringify([entry.epoch ?? "", entry.traceId, entry.spanId]) : null);
            if (prefix) yield { ...entry, id: prefix + ":" + String(entry.position).padStart(16, "0") };
          }
        }
        if (!after && !relations.count()) relations.seed(pointers());
        else for (const entry of pointers()) {
          relations.reference(entry.id, entry.file, entry.offset, entry.length, entry);
          if (++batch % 5000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        this.setMeta(cursor, position);
      })().finally(() => { this.relationRefresh.delete(kind); release(); });
      this.relationRefresh.set(kind, pending);
    }
    return pending;
  }
  async queryEvents(options: { afterPosition?: number; beforePosition?: number; reverse?: boolean; limit?: number; epoch?: string | null; model?: string; traceId?: string; spanId?: string; types?: string[] } = {}) {
    const found: RecordPointer[] = [], limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const store = this.store("events");
    let candidates: Iterable<RecordPointer>;
    if (options.model !== undefined || (options.traceId && options.spanId)) {
      const kind = options.model !== undefined ? "model" : "span";
      await this.ensureRelations(kind);
      const prefix = (kind === "model" ? JSON.stringify(options.model) : JSON.stringify([options.epoch ?? "", options.traceId, options.spanId])) + ":";
      candidates = this.store(`event-${kind}s`).entries({ prefix });
      // Related groups are small; reverse reads retain only the requested page below.
    } else candidates = store.versions({ after: options.afterPosition ?? 0, before: options.beforePosition, reverse: options.reverse,
      where: { ...(options.epoch ? { epoch: options.epoch } : {}), ...(options.types?.length === 1 ? { type: options.types[0] } : {}) } });
    const reversedGroup = options.reverse && (options.model !== undefined || (options.traceId && options.spanId));
    for (const entry of candidates) {
      if (entry.position <= (options.afterPosition ?? 0) || entry.position >= (options.beforePosition ?? Infinity) ||
        (options.epoch !== undefined && (entry.epoch ?? "") !== (options.epoch ?? "")) ||
        (options.traceId !== undefined && entry.traceId !== options.traceId) ||
        (options.spanId !== undefined && entry.spanId !== options.spanId) ||
        (options.types && !options.types.includes(entry.type))) continue;
      found.push(entry);
      if (reversedGroup) { if (found.length > limit) found.shift(); }
      else if (found.length >= limit) break;
    }
    if (reversedGroup) found.reverse();
    return Promise.all(found.map(async entry => ({ position: entry.position as number, event: await store.read<Event>(entry) })));
  }
  refreshEvents() {
    if (!this.refreshing) this.refreshing = this.exclusive(() => this.appendEvents()).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
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
  for (const entry of entries) entry.close();
}
