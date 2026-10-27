import { open } from "node:fs/promises";
import { Readable } from "node:stream";

export interface FileMedia { file: string; mediaType: string; cacheControl?: string }

/** Single byte ranges keep video seeking bounded, even for very large recordings. */
export function byteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || !size || (!match[1] && !match[2])) throw new RangeError("Invalid byte range");
  const first = match[1] ? Number(match[1]) : undefined, last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last)))
    throw new RangeError("Invalid byte range");
  const start = first ?? Math.max(0, size - last!);
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1);
  if (start < 0 || start >= size || end < start) throw new RangeError("Unsatisfiable byte range");
  return { start, end };
}

/** The caller authorizes and canonicalizes the file; no whole-file Buffer is created here. */
export async function fileResponse(request: Request, media: FileMedia): Promise<Response> {
  const handle = await open(media.file, "r");
  let ownsHandle = true;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("Invalid media file");
    const headers = new Headers({ "Content-Type": media.mediaType, "Accept-Ranges": "bytes",
      "Cache-Control": media.cacheControl ?? "no-store", "X-Content-Type-Options": "nosniff" });
    let range: ReturnType<typeof byteRange>;
    try { range = byteRange(request.headers.get("range"), stat.size); }
    catch {
      headers.set("Content-Range", `bytes */${stat.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (request.method === "HEAD" || !stat.size) return new Response(null, { status: range ? 206 : 200, headers });
    request.signal.throwIfAborted();
    const stream = handle.createReadStream({ start, end, autoClose: true, highWaterMark: 64 * 1024 });
    ownsHandle = false;
    const abort = () => stream.destroy(new DOMException("Aborted", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } finally {
    if (ownsHandle) await handle.close();
  }
}
