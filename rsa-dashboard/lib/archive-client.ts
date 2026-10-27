/** A cold directory can advance across bounded HTTP requests. It is never an
 * empty history page. Abort also cancels the delay and the next request. */
export type ArchiveProgress = { bytes: number; totalBytes: number; projection?: { position: number; total: number; complete: boolean } };
export async function readArchiveJson<T>(url: string, signal?: AbortSignal,
  onProgress?: (progress: ArchiveProgress) => void): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    const response = await fetch(url, { cache: "no-store", signal });
    const body = await response.json();
    signal?.throwIfAborted();
    if (response.status === 202 && body.code === "ARCHIVE_PREPARING") {
      if (body.progress) onProgress?.(body.progress);
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, 250);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      });
      continue;
    }
    if (!response.ok) throw new Error(body.error ?? `读取失败 · HTTP ${response.status}`);
    return body;
  }
}
