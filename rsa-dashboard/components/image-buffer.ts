/** Decoded images owned by one viewer, never a global or whole-run cache. */
import { mediaFailureMessage } from "./observation-model";
export type BufferedImage = { src: string; width: number; height: number; bytes: number; error?: string; dispose(): void };
type Loader = (url: string, signal: AbortSignal) => Promise<BufferedImage>;
const failure = (error: unknown): BufferedImage => ({ src: "", width: 0, height: 0, bytes: 0,
  error: error instanceof Error ? error.message : "无法读取画面", dispose() {} });

async function loadImage(url: string, signal: AbortSignal): Promise<BufferedImage> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new Error(mediaFailureMessage(response.status));
  const blob = await response.blob();
  signal.throwIfAborted();
  const src = URL.createObjectURL(blob), image = new Image();
  const dispose = () => { image.src = ""; URL.revokeObjectURL(src); };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    image.src = src;
    await image.decode();
    signal.throwIfAborted();
    return { src, width: image.naturalWidth, height: image.naturalHeight,
      bytes: blob.size + image.naturalWidth * image.naturalHeight * 4, dispose };
  } catch (error) { dispose(); throw error; }
  finally { signal.removeEventListener("abort", dispose); }
}

export class ImageBuffer {
  private entries = new Map<string, { controller: AbortController; promise: Promise<BufferedImage>; value?: BufferedImage }>();
  constructor(private loader: Loader = loadImage) {}
  load(url: string): Promise<BufferedImage> {
    const existing = this.entries.get(url);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const entry = { controller, promise: null! as Promise<BufferedImage>, value: undefined as BufferedImage | undefined };
    this.entries.set(url, entry);
    entry.promise = this.loader(url, controller.signal).catch(failure).then(value => {
      if (this.entries.get(url) !== entry) value.dispose();
      else entry.value = value;
      return value;
    });
    return entry.promise;
  }
  async prepare(urls: string[]) {
    return new Map(await Promise.all([...new Set(urls)].map(async url => [url, await this.load(url)] as const)));
  }
  retain(urls: string[]) {
    const keep = new Set(urls);
    for (const [url, entry] of this.entries) if (!keep.has(url)) {
      this.entries.delete(url); entry.controller.abort(); entry.value?.dispose();
    }
  }
  /** Only speculative images are evictable: displayed/target images must remain usable. */
  trimPrefetch(required: string[], maxBytes = 32 * 1024 * 1024) {
    const keep = new Set(required);
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + (entry.value?.bytes ?? 0), 0);
    for (const [url, entry] of [...this.entries].reverse()) {
      if (bytes <= maxBytes) break;
      if (keep.has(url) || !entry.value) continue;
      bytes -= entry.value.bytes;
      this.entries.delete(url); entry.controller.abort(); entry.value.dispose();
    }
  }
  clear() { this.retain([]); }
}
