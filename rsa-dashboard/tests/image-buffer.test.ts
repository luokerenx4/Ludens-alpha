import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageBuffer, type BufferedImage } from "../components/image-buffer";

function controlled() {
  const jobs = new Map<string, { signal: AbortSignal; resolve(value: BufferedImage): void; reject(error: Error): void }>();
  const released: string[] = [];
  const buffer = new ImageBuffer((url, signal) => new Promise((resolve, reject) => jobs.set(url, { signal, resolve, reject })));
  const image = (url: string, bytes = 4): BufferedImage => ({ src: url, width: 1, height: 1, bytes, dispose: () => { released.push(url); } });
  return { buffer, jobs, image, released };
}

test("a dual-screen frame commits only after both images settle; prefetch is reused", async () => {
  const f = controlled();
  const prefetched = f.buffer.load("top");
  assert.equal(f.buffer.load("top"), prefetched);
  let committed = false;
  const frame = f.buffer.prepare(["top", "bottom"]).then(value => { committed = true; return value; });
  f.jobs.get("top")!.resolve(f.image("top")); await prefetched;
  assert.equal(committed, false);
  f.jobs.get("bottom")!.resolve(f.image("bottom"));
  assert.deepEqual([...await frame].map(([key]) => key), ["top", "bottom"]);
  f.buffer.clear(); assert.deepEqual(f.released.sort(), ["bottom", "top"]);
});

test("a failed screen cannot block the other screen or following frame", async () => {
  const f = controlled();
  const frame = f.buffer.prepare(["top", "missing"]);
  f.jobs.get("top")!.resolve(f.image("top")); f.jobs.get("missing")!.reject(new Error("expired"));
  const result = await frame;
  assert.equal(result.get("top")!.src, "top"); assert.equal(result.get("missing")!.error, "expired");
  f.buffer.retain(["next"]);
  const next = f.buffer.prepare(["next"]); f.jobs.get("next")!.resolve(f.image("next"));
  assert.equal((await next).get("next")!.src, "next"); f.buffer.clear();
});

test("seeking cancels obsolete requests and late completions release their resources", async () => {
  const f = controlled();
  const obsolete = f.buffer.load("old"); const oldJob = f.jobs.get("old")!;
  f.buffer.clear(); assert.equal(oldJob.signal.aborted, true);
  const newer = f.buffer.load("old");
  oldJob.resolve(f.image("old-generation")); await obsolete;
  f.jobs.get("old")!.resolve(f.image("new-generation")); await newer;
  assert.deepEqual(f.released, ["old-generation"]);
  assert.equal((await f.buffer.load("old")).src, "new-generation");
  f.buffer.clear(); assert.deepEqual(f.released, ["old-generation", "new-generation"]);
});

test("prefetch memory is bounded without evicting displayed images; old frames are released", async () => {
  const f = controlled();
  for (const url of ["displayed", "next1", "next2"]) {
    const ready = f.buffer.load(url); f.jobs.get(url)!.resolve(f.image(url, 10)); await ready;
  }
  f.buffer.trimPrefetch(["displayed"], 20);
  assert.deepEqual(f.released, ["next2"]);
  f.buffer.retain(["next1"]);
  assert.deepEqual(f.released, ["next2", "displayed"]);
  f.buffer.clear(); assert.equal(f.released.length, 3);
});
