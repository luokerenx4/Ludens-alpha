import { mkdirSync, openSync, closeSync, readSync, writeSync, statSync, existsSync, renameSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CHUNK = 1024 * 1024, SEGMENT = 8 * CHUNK, PAGE_ROWS = 1024;
export type RecordPointer = Record<string, any> & { id: string; file: string; offset: number; length: number };
export class SourceChanged extends Error {}
type Where = Record<string, unknown>;
type Page = { file: string; min: string; max: string; count: number; bytes: number; facets: Record<string, Record<string, number>>; first?: number; last?: number };
type Manifest = { version: 1; next: number; pages: Page[]; history: Page[]; count: number; facets: Record<string, number> };
type Cached = { owner: FileRecords; page: Page; rows: RecordPointer[]; dirty: boolean; weight: number };
const cacheKey = Symbol.for("ludens.dashboard.index-pages");
const cacheState = ((globalThis as any)[cacheKey] ??= { entries: new Map<string, Cached>(), bytes: 0 }) as { entries: Map<string, Cached>; bytes: number };
const cache = cacheState.entries;
const cacheLimit = () => Math.max(CHUNK, Number(process.env.RSA_DASHBOARD_INDEX_CACHE_BYTES) || 32 * CHUNK);
const fields = ["epoch", "kind", "status", "type"];
const key = (v: unknown) => JSON.stringify(v ?? null);
const matches = (row: RecordPointer, where: Where = {}) => Object.entries(where).every(([k, v]) => row[k] === v);
const possible = (page: Page, where: Where = {}) => Object.entries(where).every(([k, v]) => !fields.includes(k) || !!page.facets[k]?.[key(v)]);
const order = (p: RecordPointer) => Number(p.position ?? p.revision ?? 0);
function lower(rows: RecordPointer[], id: string) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].id < id) lo = mid + 1; else hi = mid; }
  return lo;
}
export function recordCacheStats() { return { pages: cache.size, bytes: cacheState.bytes, limit: cacheLimit() }; }
function save(entry: Cached) {
  if (!entry.dirty) return;
  const path = join(entry.owner.pageDirectory, entry.page.file);
  writeFileSync(path + ".tmp", entry.rows.map(row => JSON.stringify(row)).join("\n") + (entry.rows.length ? "\n" : ""));
  renameSync(path + ".tmp", path); entry.dirty = false;
}
function trim() {
  while (cacheState.bytes > cacheLimit() && cache.size > 1) {
    const [id, entry] = cache.entries().next().value!;
    save(entry); cacheState.bytes -= entry.weight; cache.delete(id);
  }
}
/** Stream complete records; an incomplete final append is not committed. */
export function* lines(path: string, chunkSize = CHUNK): Generator<{ line: string; offset: number; length: number }> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r"), buffer = Buffer.alloc(chunkSize);
  let pending = Buffer.alloc(0), offset = 0;
  try {
    for (;;) {
      const n = readSync(fd, buffer); if (!n) break;
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

type ImportRow = { ordinal: number; pointer: RecordPointer };
function* legacyPointers(path: string): Generator<RecordPointer> {
  for (const { line } of lines(path)) yield JSON.parse(line) as RecordPointer;
}
const importOrder = (a: ImportRow, b: ImportRow) => a.pointer.id === b.pointer.id
  ? a.ordinal - b.ordinal : a.pointer.id < b.pointer.id ? -1 : 1;
/** Merge sorted chunks with one head and an 8 KiB read buffer per input. */
function* mergeChunks(paths: string[]): Generator<ImportRow> {
  const inputs = paths.map(path => lines(path, 8192));
  const heap: { row: ImportRow; input: number }[] = [];
  try {
    inputs.forEach((input, i) => { const next = input.next(); if (!next.done) heap.push({ row: JSON.parse(next.value.line), input: i }); });
    heap.sort((a, b) => importOrder(a.row, b.row));
    while (heap.length) {
      const first = heap[0]; yield first.row;
      const next = inputs[first.input].next();
      if (!next.done) first.row = JSON.parse(next.value.line);
      else { const last = heap.pop()!; if (heap.length) heap[0] = last; }
      for (let parent = 0; parent * 2 + 1 < heap.length;) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && importOrder(heap[child + 1].row, heap[child].row) < 0) child++;
        if (importOrder(heap[parent].row, heap[child].row) <= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child;
      }
    }
  } finally { for (const input of inputs) input.return(undefined); }
}
function writeChunk(path: string, rows: Iterable<ImportRow>) {
  const fd = openSync(path, "w"); let pending = "";
  try {
    for (const row of rows) {
      pending += JSON.stringify(row) + "\n";
      if (pending.length >= 64 * 1024) { writeSync(fd, pending); pending = ""; }
    }
    if (pending) writeSync(fd, pending);
  } finally { closeSync(fd); }
}

/** Sparse page directory in memory, bounded decoded pages, bodies read only on demand. */
export class FileRecords {
  readonly pageDirectory: string;
  private manifest: Manifest;
  private changed = false;
  private readers = new Map<string, number>();
  private dataFd?: number;
  private dataFile = "";
  private dataOffset = 0;
  private part = 0;
  constructor(readonly directory: string, private onWrite = () => {}, private keepHistory = false) {
    mkdirSync(directory, { recursive: true });
    this.pageDirectory = join(directory, "pages");
    const manifestPath = join(this.pageDirectory, "manifest.json");
    if (existsSync(manifestPath)) this.manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    else {
      // Legacy pointer files are authoritative until the new directory is fully committed.
      rmSync(this.pageDirectory, { recursive: true, force: true }); mkdirSync(this.pageDirectory);
      this.manifest = { version: 1, next: 0, pages: [], history: [], count: 0, facets: {} };
      try { this.importRecords(legacyPointers(join(directory, "index.jsonl"))); this.changed = true; this.flush(); }
      catch (error) {
        for (const [id, entry] of cache) if (entry.owner === this) { cacheState.bytes -= entry.weight; cache.delete(id); }
        throw error;
      }
    }
    for (const file of readdirSync(directory)) {
      const match = /^data-(\d+)\.jsonl$/.exec(file);
      if (match) this.part = Math.max(this.part, Number(match[1]));
    }
  }
  /** Initialize a new derived store from a bounded stream; existing indexes are never replaced. */
  seed(records: Iterable<RecordPointer>) {
    if (this.manifest.pages.length || this.manifest.history.length)
      throw new Error("Bulk initialization requires an empty store");
    this.onWrite(); this.importRecords(records); this.changed = true; this.flush();
  }
  private importRecords(records: Iterable<RecordPointer>) {
    const temporary = join(this.pageDirectory, "import"); mkdirSync(temporary);
    let chunks: string[] = [], batch: ImportRow[] = [], batchBytes = 0, ordinal = 0, nextChunk = 0;
    let history: RecordPointer[] = [], historyBytes = 0, latest: RecordPointer[] = [], latestBytes = 0;
    const flushBatch = () => {
      if (!batch.length) return;
      const path = join(temporary, String(nextChunk++));
      writeChunk(path, batch.sort(importOrder)); chunks.push(path); batch = []; batchBytes = 0;
    };
    const flushHistory = () => {
      if (!history.length) return;
      const page = this.newPage(history); page.first = order(history[0]); page.last = order(history.at(-1)!);
      this.manifest.history.push(page); history = []; historyBytes = 0;
    };
    const appendLatest = (pointer: RecordPointer) => {
      if (pointer.deleted) return;
      latest.push(pointer); latestBytes += Buffer.byteLength(JSON.stringify(pointer)) + 1; this.facet(pointer, 1);
      if (latest.length >= PAGE_ROWS || latestBytes >= 256 * 1024) {
        this.manifest.pages.push(this.newPage(latest)); latest = []; latestBytes = 0;
      }
    };
    try {
      for (const pointer of records) {
        const length = Buffer.byteLength(JSON.stringify(pointer)) + 1;
        batch.push({ pointer, ordinal: ordinal++ }); batchBytes += length;
        if (this.keepHistory && !pointer.deleted) {
          history.push(pointer); historyBytes += length;
          if (history.length >= PAGE_ROWS || historyBytes >= 256 * 1024) flushHistory();
        }
        if (batch.length >= 16_384 || batchBytes >= 8 * CHUNK) flushBatch();
      }
      flushBatch(); flushHistory();
      // Bound open descriptors even for multi-million-row source indexes.
      while (chunks.length > 64) {
        const merged: string[] = [];
        for (let i = 0; i < chunks.length; i += 64) {
          const group = chunks.slice(i, i + 64), path = join(temporary, String(nextChunk++));
          writeChunk(path, mergeChunks(group)); merged.push(path);
          for (const input of group) rmSync(input);
        }
        chunks = merged;
      }
      let last: RecordPointer | undefined;
      for (const { pointer } of mergeChunks(chunks)) {
        if (last && last.id !== pointer.id) appendLatest(last);
        last = pointer;
      }
      if (last) appendLatest(last);
      if (latest.length) this.manifest.pages.push(this.newPage(latest));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  private locate(id: string) {
    let lo = 0, hi = this.manifest.pages.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.manifest.pages[mid].max < id) lo = mid + 1; else hi = mid; }
    return Math.min(lo, Math.max(0, this.manifest.pages.length - 1));
  }
  private load(page: Page): Cached {
    const id = join(this.pageDirectory, page.file);
    let entry = cache.get(id);
    if (!entry) {
      const rows = [...lines(id)].map(({ line }) => JSON.parse(line) as RecordPointer);
      entry = { owner: this, page, rows, dirty: false, weight: Math.max(128, page.bytes * 4) };
      if (entry.weight > cacheLimit()) return entry;
      cacheState.bytes += entry.weight;
    } else cache.delete(id);
    cache.set(id, entry); trim(); return entry;
  }
  private update(entry: Cached, removed?: RecordPointer, added?: RecordPointer) {
    const { rows, page } = entry;
    const id = join(this.pageDirectory, page.file);
    if (cache.has(id)) { cacheState.bytes -= entry.weight; cache.delete(id); }
    page.count = rows.length; page.min = rows[0]?.id ?? ""; page.max = rows.at(-1)?.id ?? "";
    if (removed || added) {
      for (const [row, delta] of [[removed, -1], [added, 1]] as const) {
        if (!row) continue;
        page.bytes += delta * (Buffer.byteLength(JSON.stringify(row)) + 1);
        for (const field of fields) {
          const counts = page.facets[field] ??= {}, k = key(row[field]);
          const n = (counts[k] ?? 0) + delta;
          if (n) counts[k] = n; else delete counts[k];
        }
      }
    } else {
      page.bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
      page.facets = {};
      for (const field of fields) {
        const counts: Record<string, number> = {};
        for (const row of rows) { const k = key(row[field]); counts[k] = (counts[k] ?? 0) + 1; }
        page.facets[field] = counts;
      }
    }
    entry.weight = Math.max(128, page.bytes * 4); entry.dirty = true;
    this.changed = true;
    if (entry.weight > cacheLimit()) { save(entry); return; }
    cacheState.bytes += entry.weight; cache.set(id, entry); trim();
  }
  private newPage(rows: RecordPointer[]): Page {
    const page: Page = { file: `${String(this.manifest.next++).padStart(8, "0")}.jsonl`, min: "", max: "", count: 0, bytes: 0, facets: {} };
    const entry = { owner: this, page, rows, dirty: true, weight: 0 };
    cache.set(join(this.pageDirectory, page.file), entry); this.update(entry); return page;
  }
  private facet(pointer: RecordPointer, delta: number) {
    const k = JSON.stringify([pointer.epoch ?? null, pointer.kind ?? null, pointer.status ?? null]);
    const n = (this.manifest.facets[k] ?? 0) + delta;
    if (n) this.manifest.facets[k] = n; else delete this.manifest.facets[k];
    this.manifest.count += delta;
  }
  private retain(pointer: RecordPointer) {
    const pages = this.manifest.pages;
    if (!pages.length) pages.push(this.newPage([]));
    const at = this.locate(pointer.id), entry = this.load(pages[at]), i = lower(entry.rows, pointer.id);
    const old = entry.rows[i]?.id === pointer.id ? entry.rows[i] : undefined;
    if (old) { this.facet(old, -1); entry.rows.splice(i, 1); }
    if (!pointer.deleted) { entry.rows.splice(i, 0, pointer); this.facet(pointer, 1); }
    this.update(entry, old, pointer.deleted ? undefined : pointer);
    if (!entry.rows.length && pages.length > 1) pages.splice(at, 1);
    if (entry.rows.length > 1 && (entry.rows.length > PAGE_ROWS || entry.page.bytes > 256 * 1024)) {
      const right = entry.rows.splice(entry.rows.length >>> 1);
      this.update(entry); pages.splice(at + 1, 0, this.newPage(right));
    }
    if (this.keepHistory && !pointer.deleted) {
      let page = this.manifest.history.at(-1);
      if (!page || page.count >= PAGE_ROWS || page.bytes >= 256 * 1024) {
        page = this.newPage([]); this.manifest.history.push(page);
      }
      const history = this.load(page); history.rows.push(pointer); this.update(history, undefined, pointer);
      page.first = order(history.rows[0]); page.last = order(pointer);
    }
  }
  *entries(options: { where?: Where; prefix?: string } = {}): IterableIterator<RecordPointer> {
    const pages = this.manifest.pages.slice(), start = options.prefix ? this.locate(options.prefix) : 0;
    for (let n = start; n < pages.length; n++) {
      const page = pages[n];
      if (options.prefix && page.min > options.prefix && !page.min.startsWith(options.prefix)) break;
      if (!possible(page, options.where)) continue;
      for (const row of this.load(page).rows.slice()) if ((!options.prefix || row.id.startsWith(options.prefix)) && matches(row, options.where)) yield row;
    }
  }
  *versions(options: { after?: number; before?: number; reverse?: boolean; where?: Where } = {}): IterableIterator<RecordPointer> {
    if (!this.keepHistory) return;
    const pages = this.manifest.history.slice(); if (options.reverse) pages.reverse();
    for (const page of pages) {
      if ((page.last ?? 0) <= (options.after ?? -1) || (page.first ?? 0) >= (options.before ?? Infinity) || !possible(page, options.where)) continue;
      const rows = this.load(page).rows;
      for (let j = 0; j < rows.length; j++) {
        const row = rows[options.reverse ? rows.length - 1 - j : j], position = order(row);
        if (position > (options.after ?? -1) && position < (options.before ?? Infinity) && matches(row, options.where)) yield row;
      }
    }
  }
  count(where: Where = {}) {
    if (!Object.keys(where).length) return this.manifest.count;
    const columns = ["epoch", "kind", "status"];
    if (Object.keys(where).every(k => columns.includes(k))) {
      let total = 0;
      for (const [facet, count] of Object.entries(this.manifest.facets)) {
        const values = JSON.parse(facet);
        if (Object.entries(where).every(([k, v]) => values[columns.indexOf(k)] === (v ?? null))) total += count;
      }
      return total;
    }
    let total = 0; for (const _ of this.entries({ where })) total++; return total;
  }
  meta(id: string) {
    if (!this.manifest.pages.length) return undefined;
    const rows = this.load(this.manifest.pages[this.locate(id)]).rows, i = lower(rows, id);
    return rows[i]?.id === id ? rows[i] : undefined;
  }
  async read<T = any>(pointer: RecordPointer): Promise<T> {
    let fd = this.readers.get(pointer.file);
    if (fd === undefined) {
      fd = openSync(pointer.file, "r"); this.readers.set(pointer.file, fd);
      if (this.readers.size > 8) { const oldest = this.readers.keys().next().value!; closeSync(this.readers.get(oldest)!); this.readers.delete(oldest); }
    } else { this.readers.delete(pointer.file); this.readers.set(pointer.file, fd); }
    const buffer = Buffer.alloc(pointer.length); let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, pointer.offset + offset);
      if (!n) throw new SourceChanged(pointer.file); offset += n;
    }
    return JSON.parse(buffer.toString("utf8"));
  }
  async get<T = any>(id: string): Promise<T | undefined> { const pointer = this.meta(id); return pointer ? this.read<T>(pointer) : undefined; }
  reference(id: string, file: string, offset: number, length: number, metadata: Record<string, unknown>) {
    this.onWrite(); this.retain({ ...metadata, id, file, offset, length });
  }
  async put(id: string, value: unknown, metadata: Record<string, unknown> = {}) {
    this.onWrite(); const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (this.dataFd !== undefined && this.dataOffset >= SEGMENT) { closeSync(this.dataFd); this.dataFd = undefined; this.part++; }
    if (this.dataFd === undefined) {
      this.dataFile = join(this.directory, `data-${String(this.part).padStart(6, "0")}.jsonl`);
      this.dataFd = openSync(this.dataFile, "a"); this.dataOffset = statSync(this.dataFile).size;
    }
    let written = 0; while (written < bytes.length) written += writeSync(this.dataFd, bytes, written);
    this.reference(id, this.dataFile, this.dataOffset, bytes.length, metadata); this.dataOffset += bytes.length;
  }
  async delete(id: string) {
    if (!this.meta(id)) return;
    this.onWrite(); this.retain({ id, file: "", offset: 0, length: 0, deleted: true });
  }
  flush() {
    if (!this.changed) return;
    for (const entry of cache.values()) if (entry.owner === this) save(entry);
    const path = join(this.pageDirectory, "manifest.json");
    writeFileSync(path + ".tmp", JSON.stringify(this.manifest)); renameSync(path + ".tmp", path); this.changed = false;
  }
  close() {
    this.flush();
    for (const [id, entry] of cache) if (entry.owner === this) { cacheState.bytes -= entry.weight; cache.delete(id); }
    for (const fd of this.readers.values()) closeSync(fd); this.readers.clear();
    if (this.dataFd !== undefined) closeSync(this.dataFd); this.dataFd = undefined;
  }
}
