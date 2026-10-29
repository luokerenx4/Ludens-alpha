import { test } from "node:test";
import assert from "node:assert/strict";
import { observationMediaStatus, readObservationText } from "../components/observation-media";

// These functions back the real media components. No device/model operation is involved.
test("a failed text read releases the response; an explicit retry reads the identical URL", async () => {
  const savedFetch = globalThis.fetch;
  const calls: { url: string; cache?: RequestCache; method?: string }[] = [];
  let cancelled = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), cache: options?.cache, method: options?.method });
    return calls.length === 1
      ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 409 })
      : new Response("  unchanged\n\ttext\n");
  };
  try {
    await assert.rejects(readObservationText("/api/media?id=same", new AbortController().signal), { httpStatus: 409 });
    assert.equal(cancelled, 1); assert.equal(calls.length, 1);
    const text = await readObservationText("/api/media?id=same", new AbortController().signal);
    assert.equal(text, "  unchanged\n\ttext\n");
    assert.deepEqual(calls, [
      { url: "/api/media?id=same", cache: "no-store", method: undefined },
      { url: "/api/media?id=same", cache: "no-store", method: undefined },
    ]);
  } finally { globalThis.fetch = savedFetch; }
});

test("late text from a superseded scope is rejected even if the fetch ignores cancellation", async () => {
  const savedFetch = globalThis.fetch;
  let resolve!: (response: Response) => void;
  let requestSignal: AbortSignal | null | undefined;
  let cancelled = 0;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options?.signal;
    return new Promise<Response>(accept => { resolve = accept; });
  };
  const controller = new AbortController();
  try {
    const pending = readObservationText("/api/media?id=old", controller.signal);
    controller.abort(); assert.equal(requestSignal?.aborted, true);
    resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelled, 1);
  } finally { globalThis.fetch = savedFetch; }
});

test("audio/status probes cancel their response body and never read or play media", async () => {
  const savedFetch = globalThis.fetch;
  let cancelled = 0;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options ?? {});
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: calls.length === 1 ? 410 : 200 });
  };
  try {
    assert.equal(await observationMediaStatus("/api/media?id=audio", new AbortController().signal), 410);
    assert.equal(await observationMediaStatus("/api/media?id=audio", new AbortController().signal), 200);
    assert.equal(cancelled, 2);
    assert(calls.every(call => call.cache === "no-store" && call.method === undefined && call.body === undefined));
  } finally { globalThis.fetch = savedFetch; }
});

test("a cancelled status probe releases a late response without reporting it as current", async () => {
  const savedFetch = globalThis.fetch;
  let resolve!: (response: Response) => void;
  let cancelled = 0;
  globalThis.fetch = async () => new Promise<Response>(accept => { resolve = accept; });
  const controller = new AbortController();
  try {
    const pending = observationMediaStatus("/api/media?id=old-audio", controller.signal);
    controller.abort();
    resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 }));
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(cancelled, 1);
  } finally { globalThis.fetch = savedFetch; }
});
