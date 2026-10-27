import { open, realpath, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CapturedSource } from "./cold-build-protocol";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const changed = () => Object.assign(new Error("构建期间日志源被替换、截断或改写"), { code: "ARCHIVE_SOURCE_CHANGED" });
async function sourceFile(root: string, relative: string) {
  const path = join(root, relative);
  if (await realpath(path) !== path || !path.startsWith(root + "/")) throw changed();
  return path;
}
async function slice(handle: Awaited<ReturnType<typeof open>>, offset: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
async function hashes(handle: Awaited<ReturnType<typeof open>>, size: number) {
  return { head: hash(await slice(handle, 0, Math.min(size, 4096))), tail: hash(await slice(handle, Math.max(0, size - 256), Math.min(size, 256))) };
}

/** Fix the last complete JSONL boundary without reading a whole source into memory. */
export async function captureSources(root: string, signal?: AbortSignal): Promise<CapturedSource> {
  const files = ["events.jsonl"];
  try { for (const entry of await readdir(join(root, "streams"), { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push("streams/" + entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const result: CapturedSource = { snapshot: {}, checks: {} };
  for (const relative of files) {
    signal?.throwIfAborted();
    const path = await sourceFile(root, relative), handle = await open(path, "r");
    try {
      const info = await handle.stat();
      let size = info.size;
      while (size > 0) {
        signal?.throwIfAborted();
        const start = Math.max(0, size - 65536), bytes = await slice(handle, start, size - start), newline = bytes.lastIndexOf(10);
        if (newline >= 0) { size = start + newline + 1; break; }
        size = start;
      }
      result.snapshot[relative] = { identity: `${info.dev}:${info.ino}`, size, mtime: info.mtimeMs };
      result.checks[relative] = { sourceSize: info.size, ...await hashes(handle, size) };
    } finally { await handle.close(); }
  }
  await verifySources(root, result, signal);
  return result;
}

/** Appending is allowed. Publishing a directory for another source identity is not. */
export async function verifySources(root: string, captured: CapturedSource, signal?: AbortSignal) {
  for (const [relative, before] of Object.entries(captured.snapshot)) {
    signal?.throwIfAborted();
    const path = await sourceFile(root, relative), info = await stat(path), check = captured.checks[relative];
    if (`${info.dev}:${info.ino}` !== before.identity || info.size < check.sourceSize ||
      (info.size === check.sourceSize && info.mtimeMs !== before.mtime)) throw changed();
    const handle = await open(path, "r");
    try {
      const after = await hashes(handle, before.size);
      if (after.head !== check.head || after.tail !== check.tail) throw changed();
    } finally { await handle.close(); }
  }
}
