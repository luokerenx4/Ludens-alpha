/** Bounded, offline access to recorded video frames. Never starts a sampler. */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pythonExecutable, pythonEnvironment } from "./python";
import type { TimelineAssetReference, VideoFrameReference } from "./timeline-types";
export type { TimelineAssetReference, VideoFrameReference } from "./timeline-types";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT = 2, MAX_WAITING = 16;
let active = 0;
const waiting: (() => void)[] = [];

export function validateVideoReference(ref: TimelineAssetReference): asserts ref is TimelineAssetReference & { video: VideoFrameReference } {
  const video = ref.video;
  if (!/^(?:window-[a-zA-Z0-9_-]+\/)?video\/(?:gap-)?[a-f0-9-]+\.mp4$/.test(ref.asset)
    || !video || !Number.isSafeInteger(video.pts) || video.pts < 0
    || !Array.isArray(video.timeBase) || video.timeBase.length !== 2
    || !video.timeBase.every(n => Number.isSafeInteger(n) && n > 0)
    || ![video.width, video.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768))
    throw new Error("Invalid timeline video frame reference");
}

function command(root: string, ref: TimelineAssetReference) {
  validateVideoReference(ref);
  if (ref.video.status === "gap") throw Object.assign(new Error(`Recording gap: ${ref.video.reason ?? "frame not encoded"}`), { status: 410 });
  const canonical = realpathSync(root);
  if (canonical !== root)
    throw new Error("Timeline media must remain inside its canonical workspace");
  const statusPath = join(root, ref.asset + ".json");
  let state: { status: string; error?: string };
  try {
    if (realpathSync(statusPath) !== statusPath || statSync(statusPath).size > 64 * 1024)
      throw new Error("Invalid timeline video status file");
    state = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(new Error("Recorded video is unavailable: status is missing"), { status: 410 });
    throw error;
  }
  if (state.status !== "ready") throw Object.assign(new Error(state.status === "pending"
    ? "Recorded video is pending: encoding has not finished"
    : `Recorded video is unavailable: ${state.error ?? state.status}`), { status: state.status === "pending" ? 409 : 410 });
  try {
    if (realpathSync(join(root, ref.asset)) !== join(root, ref.asset))
      throw new Error("Timeline media must remain inside its canonical workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(new Error("Recorded video is unavailable: segment is missing"), { status: 410 });
    throw error;
  }
  return ["-m", "rsa_tools._video", "--root", root, "--asset", ref.asset, "--pts", String(ref.video.pts),
    "--time-base", ref.video.timeBase.join("/")];
}

async function acquire(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (active < MAX_CONCURRENT) { active++; return; }
  if (waiting.length >= MAX_WAITING) throw Object.assign(new Error("Historical frame decoder is busy; retry shortly"), { status: 503 });
  await new Promise<void>((resolve, reject) => {
    const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    waiting.push(ready);
  });
}
function release() { const next = waiting.shift(); if (next) next(); else active--; }

/** No decoded history cache: the caller owns the requested frame and releases it. */
export async function decodeTimelineFrame(root: string, ref: TimelineAssetReference, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
  const args = command(root, ref);
  await acquire(options.signal);
  try {
    options.signal?.throwIfAborted();
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(pythonExecutable(), args, { env: pythonEnvironment(), encoding: "buffer", timeout: 20_000,
        maxBuffer: MAX_BYTES, signal: options.signal }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Historical frame decode failed: ${stderr.toString().slice(-2000) || error.message}`));
        else resolve(stdout);
      });
    });
  } finally { release(); }
}
