import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { EventLog } from "../src/harness/events.ts";
import { installCompactionHttpTrace, ModelTrace } from "../src/harness/omp/trace.ts";
import { readArtifact } from "../../shared/log-archive.ts";

const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "rsa-indexed-trace-"));
  const directory = join(workspace, "logs", "run");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ workspace }));
  const log = new EventLog(directory, { id: "indexed", now: () => performance.now() }, workspace);
  return { workspace, directory, log, read: (ref: unknown) => readArtifact(directory, ref, { media: "full" }),
    close: () => rm(workspace, { recursive: true, force: true }) };
}

test("indexed request, compressed HTTP and stream share semantic content with distinct wire identities", async () => {
  const f = await fixture();
  const payload = { type: "response.create", input: [{ role: "user", content: "shared history " + "x".repeat(3000) }] };
  const text = JSON.stringify(payload, null, 2), gzip = gzipSync(text);
  const trace = { epoch: "first", modelCallId: "call", requestId: "request" };
  try {
    const ref = f.log.artifact(payload);
    const wire = f.log.bytes(gzip, "bin", { contentType: "application/json", contentEncoding: "gzip" });
    expect(wire.path).toBe(ref.path);
    expect(wire.wire).toEqual({ sha256: new Bun.SHA256().update(gzip).digest("hex"), bytes: gzip.length,
      contentType: "application/json", contentEncoding: "gzip", representation: "json" });
    expect(await f.read(wire)).toEqual(payload);
    const event = { event: "response.create", data: text, raw: [": ws → response.create", "event: response.create",
      "id: 7", "retry: 200", ...text.split("\n").map(line => `data: ${line}`)] };
    const before = JSON.stringify(event);
    f.log.stream("streams/call.jsonl", event, trace);
    f.log.stream("streams/call.jsonl", { event: "done", data: "[DONE]", raw: ["data:[DONE]"] }, trace);
    f.log.stream("streams/call.jsonl", { event: "message", data: "plain\ntext", raw: [": comment", "data: plain", "data:text"] }, trace);
    expect(JSON.stringify(event)).toBe(before);
    const [request, done, plain] = await lines(join(f.directory, "streams/call.jsonl"));
    expect(request.format).toBe("rsa-stream-v1");
    expect(request.event.dataRef).toMatchObject({ sha256: ref.sha256, bytes: ref.bytes });
    expect(await f.read(request.event.dataRef)).toEqual(payload);
    expect(request.event.dataSha256).toBe(new Bun.SHA256().update(text).digest("hex"));
    expect(request.event.raw.slice(0, 4)).toEqual(event.raw.slice(0, 4));
    expect(request.event.raw[4]).toEqual({ data: true, prefix: "data: ", line: 0 });
    expect(request.event).not.toHaveProperty("data");
    expect(await f.read(done.event.dataRef)).toBe("[DONE]");
    expect(done.event.raw).toEqual([{ data: true, prefix: "data:", line: 0 }]);
    expect(await f.read(plain.event.dataRef)).toBe("plain\ntext");
    expect((await readdir(f.directory))).not.toContain("payloads");
    expect(await readFile(join(f.directory, "streams/call.jsonl"), "utf8")).not.toContain("shared history");

    const binary = f.log.bytes(new Uint8Array([0, 1, 255, 4]));
    expect(binary.wire?.representation).toBe("unavailable");
    expect(await f.read(binary)).toEqual({ unavailable: "Body is not supported UTF-8 text or JSON" });
  } finally { await f.close(); }
});

test("indexed WS capture leaves actual objects and callback framing untouched", async () => {
  const f = await fixture();
  const trace = new ModelTrace(f.log, () => ({ epoch: "epoch" }));
  const model = getBundledModels("openai-codex").find(m => m.id === "gpt-6.1-sol")!;
  const original = { type: "response.create", input: [{ text: "original" }] };
  const actual = { ...original, previous_response_id: "previous", input: [{ text: "extension replacement" }] };
  const expected = JSON.stringify(actual);
  const incoming = { event: "response.created", data: '{"response":{"id":"server"}}',
    raw: [": ws ← response.created", 'data: {"response":{"id":"server"}}'] };
  const end = new Error("offline fixture end");
  const forwarded: unknown[] = [];
  const stream = trace.wrap(async (target, _context, options) => {
    expect(await options!.onPayload!(original, target)).toBe(actual);
    const outgoing = { event: "response.create", data: expected, raw: [": ws → response.create", `data: ${expected}`] };
    options!.onSseEvent!(outgoing, target);
    expect(forwarded[0]).toBe(outgoing);
    options!.onSseEvent!(incoming, target);
    throw end;
  });
  try {
    await expect(stream(model, { messages: [] }, {
      onPayload: () => actual, onSseEvent: event => forwarded.push(event),
    })).rejects.toBe(end);
    expect(original.input[0]!.text).toBe("original");
    expect(JSON.stringify(actual)).toBe(expected);
    expect(forwarded[1]).toBe(incoming);
    const events = await lines(join(f.directory, "events.jsonl"));
    const request = events.find(e => e.type === "model_request");
    const start = events.find(e => e.type === "model_start");
    const frames = await lines(join(f.directory, start.data.streamPath));
    expect(request.data).toMatchObject({ transport: "websocket", incremental: true });
    expect(frames[0].event.dataRef).toMatchObject({ sha256: request.data.payload.sha256, bytes: request.data.payload.bytes });
    expect(await f.read(frames[0].event.dataRef)).toEqual(actual);
    expect(await f.read(request.data.payload)).toEqual(actual);
    expect(events.filter(e => e.type === "model_stream_start")).toHaveLength(1);
    expect(events.find(e => e.type === "model_end").trace).toEqual(request.trace);
  } finally { await trace.shiori.close(); await f.close(); }
});

test("indexed SSE HTTP retry, errors and cancellation keep native provider behavior and final references", async () => {
  const f = await fixture();
  const trace = new ModelTrace(f.log, () => ({ epoch: "epoch" }));
  const stream = trace.wrap(streamOpenAICompletions as StreamFn);
  const model = getBundledModels("deepseek").find(m => m.id === "deepseek-flash")!;
  const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };
  let attempts = 0;
  const bodies: string[] = [];
  try {
    const result = await stream(model, context, { apiKey: "not-a-real-key", fetch: async (input, init) => {
      bodies.push(await new Request(input, init).text());
      if (++attempts === 1) return Response.json({ error: { message: "try again" } }, { status: 503, headers: { "retry-after": "0" } });
      const chunk = { id: "response", choices: [{ index: 0, delta: { role: "assistant", content: "readable text" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    expect((await result.result()).stopReason).toBe("stop");
    const entered = Promise.withResolvers<void>();
    const control = new AbortController();
    const cancelled = await stream(model, context, { apiKey: "not-a-real-key", signal: control.signal,
      fetch: async (_input, init) => { entered.resolve(); return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }); },
    });
    await entered.promise; control.abort();
    expect((await cancelled.result()).stopReason).toBe("aborted");
    const events = await lines(join(f.directory, "events.jsonl"));
    const requests = events.filter(e => e.type === "model_request");
    const http = events.filter(e => e.type === "model_http_start");
    expect(http).toHaveLength(3);
    expect(http[0].trace.requestId).toBe(http[1].trace.requestId);
    expect(http[0].trace.httpId).not.toBe(http[1].trace.httpId);
    expect(http[0].data.body.path).toBe(requests[0].data.payload.path);
    expect(await f.read(http[0].data.body)).toEqual(JSON.parse(bodies[0]!));
    expect(bodies[0]).toBe(bodies[1]);
    expect(await f.read(events.find(e => e.type === "model_http_end" && e.data.status === 503).data.errorBody))
      .toEqual({ error: { message: "try again" } });
    const ends = events.filter(e => e.type === "model_end");
    expect(ends.map(e => e.data.stopReason)).toEqual(["stop", "aborted"]);
    expect(ends[0].data.response.encoding).toBe("rsa-json-v1");
    expect((await f.read(ends[0].data.response) as { content: unknown[] }).content).toEqual([{ type: "text", text: "readable text" }]);
    expect(events.find(e => e.type === "model_http_error").trace.requestId).toBe(ends[1].trace.requestId);
  } finally { await trace.shiori.close(); await f.close(); }
}, 30_000);

test("indexed compaction body capture keeps compressed bytes and response streams untouched", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  const payload = { model: "fixture", input: [{ text: "compaction history" }] };
  const bytes = gzipSync(JSON.stringify(payload));
  const init = { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip",
    "x-codex-turn-metadata": '{"request_kind":"compaction"}' }, body: bytes };
  const response = new Response("unread body");
  globalThis.fetch = Object.assign(async (_input: unknown, actual: unknown) => {
    expect(actual).toBe(init); return response;
  }, { preconnect: original.preconnect }) as typeof fetch;
  const dispose = installCompactionHttpTrace(f.log, () => ({ epoch: "launch-epoch" }));
  try {
    expect(await fetch("https://chatgpt.com/backend-api/codex/responses/compact", init)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(init.body).toBe(bytes);
    const [start, end] = await lines(join(f.directory, "events.jsonl"));
    expect(start.data.body.path).toBe(f.log.artifact(payload).path);
    expect(start.data.body.wire.contentEncoding).toBe("gzip");
    expect(await f.read(start.data.body)).toEqual(payload);
    expect(end.trace).toEqual(start.trace);
  } finally { dispose(); globalThis.fetch = original; await f.close(); }
});

test("indexed compaction completion keeps only statistics inline and preserves the native result and late trace", async () => {
  const f = await fixture();
  let epoch = "first";
  const trace = new ModelTrace(f.log, () => ({ epoch }));
  let emit: Parameters<AgentSession["subscribe"]>[0];
  const session = { agent: { streamFn: async () => { throw new Error("No model calls in this fixture"); } },
    subscribe(listener: typeof emit) { emit = listener; return () => {}; },
  } as unknown as AgentSession;
  const detach = trace.attach(session);
  const bytes = Buffer.from("retained compaction image"), sha256 = new Bun.SHA256().update(bytes).digest("hex");
  const asset = `objects/${sha256}.bin`;
  const result = { tokensBefore: 250000, summary: "large replacement summary ".repeat(500),
    shortSummary: "native display summary", firstKeptEntryId: "retained-entry",
    preserveData: { openaiRemoteCompaction: { version: "v2", retainedImageCount: 1,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, totalTokens: 110, reasoningOutputTokens: 3 },
      replacementHistory: [{ role: "user", content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] }],
    } } };
  const original = JSON.stringify(result);
  try {
    await mkdir(join(f.workspace, ".rsa", "timeline", "objects"), { recursive: true });
    await writeFile(join(f.workspace, ".rsa", "timeline", asset), bytes);
    f.log.archive!.registerMedia({ sha256, asset, mediaType: "image/png" });
    emit!({ type: "auto_compaction_start", action: "context-full", reason: "threshold" });
    epoch = "next";
    emit!({ type: "auto_compaction_end", action: "context-full", result, aborted: false, willRetry: false });
    expect(JSON.stringify(result)).toBe(original);
    const raw = await readFile(join(f.directory, "events.jsonl"), "utf8");
    const events = await lines(join(f.directory, "events.jsonl"));
    const start = events.find(event => event.type === "auto_compaction_start");
    const end = events.find(event => event.type === "auto_compaction_end");
    expect(end.trace).toEqual(start.trace);
    expect(end.trace.epoch).toBe("first");
    expect(end.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(end.data.result).toEqual({ tokensBefore: 250000,
      preserveData: { openaiRemoteCompaction: { retainedImageCount: 1, usage: result.preserveData.openaiRemoteCompaction.usage } } });
    expect(end.data.resultRef.encoding).toBe("rsa-json-v1");
    expect(await f.read(end.data.resultRef)).toEqual(result);
    expect(raw).not.toContain("large replacement summary");
    expect(raw).not.toContain("native display summary");
    expect(raw).not.toContain(bytes.toString("base64"));
    expect(raw).not.toContain("replacementHistory");
  } finally { detach(); await trace.shiori.close(); await f.close(); }
});
