import { mkdirSync, openSync, closeSync, readSync, writeSync, statSync, existsSync, renameSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Event } from "./types";

const FORMAT = "files-2";
const CHUNK = 1024 * 1024;
const SEGMENT = 8 * CHUNK;
export type FileState = { path: string; identity: string; size: number; mtime: number; offset: number; head: string; tail: string };
export type RecordPointer = Record<string, any> & { id: string; file: string; offset: number; length: number };
export class SourceChanged extends Error {}
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Iterate complete lines without ever allocating a whole log. */
function* lines(path: string): Generator<{ line: string; offset: number; length: number }> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r"), buffer = Buffer.alloc(CHUNK);
  let pending = Buffer.alloc(0), offset = 0;
  try {
    for (;;) {
      const n = readSync(fd, buffer);
      if (!n) break;
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let start = 0, end;
      while ((end = pending.indexOf(10, start)) >= 0) {
        const length = end - start + 1;
        yield { line: pending.subarray(start, end).toString("utf8"), offset, length };
        offset += length; start = end + 1;
      }
      pending = pending.subarray(start);
    }
  } finally { closeSync(fd); }
}

/** JSONL bodies on disk; only byte pointers and caller-supplied metadata stay resident. */
export class FileRecords {
  private latest = new Map<string, RecordPointer>();
  private readers = new Map<string, number>();
  private history: RecordPointer[] = [];
  private indexFd?: number;
  private dataFd?: number;
  private dataFile = "";
  private dataOffset = 0;
  private part = 0;
  constructor(readonly directory: string, private onWrite = () => {}, private keepHistory = false) {
    mkdirSync(directory, { recursive: true });
    for (const { line } of lines(join(directory, "index.jsonl"))) {
      const pointer = JSON.parse(line) as RecordPointer;
      this.retain(pointer);
      // Locate the append segment independently of retained versions, including
      // segments whose last record was later replaced or deleted.
      if (pointer.file.startsWith(directory + "/"))
        this.part = Math.max(this.part, Number(pointer.file.match(/data-(\d+)\.jsonl$/)?.[1] ?? 0));
    }
  }
  entries(): Iterable<RecordPointer> { return this.latest.values(); }
  versions(): readonly RecordPointer[] { return this.history; }
  meta(id: string) { return this.latest.get(id); }
  async read<T = any>(pointer: RecordPointer): Promise<T> {
    let fd = this.readers.get(pointer.file);
    if (fd === undefined) {
      fd = openSync(pointer.file, "r"); this.readers.set(pointer.file, fd);
      if (this.readers.size > 8) {
        const oldest = this.readers.keys().next().value!;
        closeSync(this.readers.get(oldest)!); this.readers.delete(oldest);
      }
    } else { this.readers.delete(pointer.file); this.readers.set(pointer.file, fd); }
    {
      const buffer = Buffer.alloc(pointer.length);
      let offset = 0;
      while (offset < buffer.length) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, pointer.offset + offset);
        if (!n) throw new SourceChanged(pointer.file);
        offset += n;
      }
      return JSON.parse(buffer.toString("utf8"));
    }
  }
  async get<T = any>(id: string): Promise<T | undefined> {
    const pointer = this.latest.get(id);
    return pointer ? this.read<T>(pointer) : undefined;
  }
  private retain(pointer: RecordPointer) {
    if (pointer.deleted) this.latest.delete(pointer.id);
    else {
      this.latest.set(pointer.id, pointer);
      if (this.keepHistory) this.history.push(pointer);
    }
  }
  private appendPointer(pointer: RecordPointer) {
    this.onWrite();
    this.indexFd ??= openSync(join(this.directory, "index.jsonl"), "a");
    writeSync(this.indexFd, JSON.stringify(pointer) + "\n");
    this.retain(pointer);
  }
  reference(id: string, file: string, offset: number, length: number, metadata: Record<string, unknown>) {
    this.appendPointer({ ...metadata, id, file, offset, length });
  }
  async put(id: string, value: unknown, metadata: Record<string, unknown> = {}) {
    this.onWrite();
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (this.dataFd !== undefined && this.dataOffset >= SEGMENT) {
      closeSync(this.dataFd); this.dataFd = undefined; this.part++;
    }
    if (this.dataFd === undefined) {
      this.dataFile = join(this.directory, `data-${String(this.part).padStart(6, "0")}.jsonl`);
      this.dataFd = openSync(this.dataFile, "a");
      this.dataOffset = statSync(this.dataFile).size;
    }
    let written = 0;
    while (written < bytes.length) written += writeSync(this.dataFd, bytes, written);
    this.reference(id, this.dataFile, this.dataOffset, bytes.length, metadata);
    this.dataOffset += bytes.length;
  }
  async delete(id: string) {
    if (!this.latest.has(id)) return;
    this.appendPointer({ id, file: "", offset: 0, length: 0, deleted: true });
  }
  close() {
    for (const fd of this.readers.values()) closeSync(fd);
    this.readers.clear();
    if (this.indexFd !== undefined) closeSync(this.indexFd);
    if (this.dataFd !== undefined) closeSync(this.dataFd);
    this.indexFd = this.dataFd = undefined;
  }
}

/** Disposable file index: raw JSONL is authoritative and remains unmodified. */
export class LogIndex {
  private pending: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> | undefined;
  private stores = new Map<string, FileRecords>();
  private metadata: Record<string, string> = {};
  private files: Record<string, FileState> = {};
  private eventPosition = 0;
  private dirty = false;
  private models = new Map<string, RecordPointer[]>();
  private groupedEvents = 0;
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
    this.files = {}; this.eventPosition = 0; this.models.clear(); this.groupedEvents = 0; this.dirty = false; this.markDirty();
  }
  async flush() {
    if (!this.dirty) return;
    const checkpoint = join(this.directory, "checkpoint.json");
    const fd = openSync(checkpoint + ".tmp", "w");
    try { writeSync(fd, JSON.stringify({ metadata: this.metadata, files: this.files })); }
    finally { closeSync(fd); }
    renameSync(checkpoint + ".tmp", checkpoint);
    rmSync(join(this.directory, ".writing"), { force: true }); this.dirty = false;
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
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
  async queryEvents(options: { afterPosition?: number; limit?: number; epoch?: string | null; model?: string; types?: string[] } = {}) {
    const found: RecordPointer[] = [], limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const events = this.store("events").versions();
    let candidates = events;
    if (options.model !== undefined) {
      for (; this.groupedEvents < events.length; this.groupedEvents++) {
        const entry = events[this.groupedEvents];
        if (!entry.model) continue;
        const group = this.models.get(entry.model) ?? [];
        group.push(entry); this.models.set(entry.model, group);
      }
      candidates = this.models.get(options.model) ?? [];
    }
    let low = 0, high = candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (Number(candidates[mid].position) <= (options.afterPosition ?? 0)) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < candidates.length; i++) {
      const entry = candidates[i];
      if ((options.epoch !== undefined && entry.epoch !== options.epoch) ||
        (options.types && !options.types.includes(entry.type))) continue;
      found.push(entry); if (found.length >= limit) break;
    }
    return Promise.all(found.map(async entry => ({ position: entry.position as number, event: await this.store("events").read<Event>(entry) })));
  }
  refreshEvents() {
    if (!this.refreshing) this.refreshing = this.exclusive(() => this.appendEvents()).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  close() { for (const store of this.stores.values()) store.close(); }
}

const registryKey = Symbol.for("ludens.dashboard.file-index");
const registry = ((globalThis as any)[registryKey] ??= new Map<string, Promise<LogIndex>>()) as Map<string, Promise<LogIndex>>;
export async function getLogIndex(path: string): Promise<LogIndex> {
  let pending = registry.get(path);
  if (!pending) {
    pending = (async () => {
      const directory = join(path, ".dashboard-index");
      await mkdir(directory, { recursive: true });
      if (await realpath(directory) !== directory) throw new Error("日志索引必须位于运行目录内");
      return new LogIndex(path, directory);
    })();
    registry.set(path, pending);
    pending.catch(() => { if (registry.get(path) === pending) registry.delete(path); });
  }
  return pending;
}
export async function loadIndexedEvents(path: string) {
  const index = await getLogIndex(path);
  await index.refreshEvents();
  return { index, generation: index.generation, revision: index.revision, eventRevision: index.eventRevision };
}
export async function closeLogIndexes() {
  const entries = [...registry.values()]; registry.clear();
  for (const entry of entries) (await entry).close();
}
