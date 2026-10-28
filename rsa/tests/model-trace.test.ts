import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { trace as otelTrace } from "@opentelemetry/api";
import { SHIORI_SOURCE } from "../src/harness/omp/shiori.ts";
import { EventLog } from "../src/harness/events.ts";
import { installCompactionHttpTrace, installCompactionSpeculationTrace, ModelTrace } from "../src/harness/omp/trace.ts";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../src/harness/baseware.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { createRsaExtension } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { captureResult, readTestController, installTestPerception } from "./runtime-fixture.ts";

const speculation = channel("omp.compaction.speculation");
const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const artifact = async (directory: string, ref: {path: string}) => gunzipSync(await readFile(join(directory, ref.path)));
const sse = (delta: unknown, finishReason: string, id: string) => [
  {id, model: "deepseek-flash", choices: [{index: 0, delta, finish_reason: null}]},
  {id, model: "deepseek-flash", choices: [{index: 0, delta: {}, finish_reason: finishReason}],
    usage: {prompt_tokens: 1234, completion_tokens: 2, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 210, total_tokens: 1236, vendor_marker: "kept-raw"}},
].map(v => `data: ${JSON.stringify(v)}\n\n`).join("") + "data: [DONE]\n\n";

test("native compaction lifecycle tracing preserves stages and epochs with only diagnostic fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-compaction-lifecycle-"));
  let now = 10, epoch = "first-epoch";
  const log = new EventLog(directory, {id: "compaction-lifecycle", now: () => now});
  const dispose = installCompactionSpeculationTrace(log, () => ({epoch}));
  const fields = {method: "summary", snapshotLeafId: "leaf", contextTokensAtStart: 200_000,
    contextTokens: 256_000, thresholdTokens: 256_000, durationMs: 80_000, tokensBefore: 256_100, reason: "history changed"};
  const messages = ["Speculative compaction started", "Speculative compaction armed", "Speculative compaction invalidated",
    "Waiting for speculative compaction", "Applying armed speculative compaction", "Speculative compaction failed", "Speculative compaction cancelled"];
  try {
    logger.debug("Unrelated compaction diagnostic", {token: "private-unrelated"});
    expect(await Bun.file(join(directory, "events.jsonl")).exists()).toBe(false);
    for (const [index, message] of messages.entries()) {
      now = 10 + index;
      epoch = index < 3 ? "first-epoch" : "next-epoch";
      speculation.runStores({operationId: `candidate-${index}`}, () => logger.debug(message, {...fields, operationId: `candidate-${index}`, stage: "private-override", prompt: "private-prompt", headers: {authorization: "private-token"}, error: "fixture failure"}));
    }
    logger.debug("Speculative compaction failed", {error: {message: "private-object"}, method: {token: "private-object"}});
    const events = await lines(join(directory, "events.jsonl"));
    expect(events.map(e => e.type)).toEqual(Array(8).fill("compaction_speculation"));
    expect(events.slice(0, 7).map(e => e.data.stage)).toEqual(["started", "armed", "invalidated", "waiting", "applied", "failed", "cancelled"]);
    for (const [index, event] of events.slice(0, 7).entries()) {
      expect(event.trace).toMatchObject({epoch: index < 3 ? "first-epoch" : "next-epoch", operationId: `candidate-${index}`});
      expect(event.trace.spanId).toBeString();
      expect(event.atMs).toBe(10 + index);
      expect(event.data).toEqual({...fields, stage: event.data.stage, ...(index === 5 ? {error: "fixture failure"} : {})});
    }
    expect(events[7].data).toEqual({stage: "failed"});
    expect(events[7].trace).toEqual({});
    expect(JSON.stringify(events)).not.toContain("private-");
    dispose();
    logger.debug("Speculative compaction started", fields);
    expect(await lines(join(directory, "events.jsonl"))).toHaveLength(8);
  } finally { dispose(); await rm(directory, {recursive: true, force: true}); }
});

test("background candidate, HTTP and retry keep their epoch across takeovers without leaking into foreground", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-compaction-gap-"));
  const log = new EventLog(directory, {id: "compaction-gap", now: () => performance.now()});
  let cycle: {epoch: string} | undefined = {epoch: "first-epoch"};
  const trace = new ModelTrace(log, () => ({epoch: cycle?.epoch}));
  let emit: Parameters<AgentSession["subscribe"]>[0];
  const session = {
    agent: {streamFn: async () => { throw new Error("No model request expected"); }},
    subscribe(listener: typeof emit) { emit = listener; return () => {}; },
  } as unknown as AgentSession;
  const originalFetch = globalThis.fetch;
  const headersReady = Promise.withResolvers<Response>();
  const summaryReady = Promise.withResolvers<void>();
  let calls = 0;
  globalThis.fetch = Object.assign(async () => ++calls === 1 ? headersReady.promise : new Response("foreground"),
    {preconnect: originalFetch.preconnect});
  const detach = trace.attach(session);
  const untraceHttp = installCompactionHttpTrace(log, trace.compactionParent);
  const endpoint = "https://chatgpt.com/backend-api/codex/responses";
  const init = {headers: {"x-codex-turn-metadata": '{"request_kind":"compaction"}'}};
  const fields = {operationId: "candidate", snapshotLeafId: "leaf"};
  try {
    const preparation = speculation.runStores(fields, async () => {
      logger.debug("Speculative compaction started", fields);
      await fetch(endpoint, init);
      await summaryReady.promise;
      logger.warn("V2 compaction attempt 1 failed, retrying in 1000ms", {error: "fixture"});
      logger.debug("Speculative compaction armed", {...fields, durationMs: 80_000});
    });
    cycle = undefined;
    headersReady.resolve(new Response("unconsumed summary stream"));
    cycle = {epoch: "next-epoch"};
    emit!({type: "auto_compaction_start", reason: "threshold", action: "context-full"});
    await fetch(endpoint, init);
    summaryReady.resolve();
    await preparation;
    logger.debug("Applying armed speculative compaction", fields);
    cycle = undefined;
    emit!({type: "auto_compaction_end", action: "context-full", result: undefined, aborted: false, willRetry: false});
    logger.debug("Speculative compaction armed", {operationId: "unknown-candidate"});
    const events = await lines(join(directory, "events.jsonl"));
    const stages = events.filter(e => e.type === "compaction_speculation");
    expect(stages.map(e => e.data.stage)).toEqual(["started", "armed", "applied", "armed"]);
    expect(stages[0].trace.epoch).toBe("first-epoch");
    expect(stages[1].trace).toEqual(stages[0].trace);
    expect(stages[2].trace).toEqual(stages[0].trace);
    expect(stages[3].trace).toEqual({operationId: "unknown-candidate"});
    const http = events.filter(e => e.type === "compaction_http_start");
    expect(http[0].trace).toMatchObject({epoch: "first-epoch", operationId: "candidate",
      traceId: stages[0].trace.traceId, parentSpanId: stages[0].trace.spanId});
    expect(http[0].trace.spanId).not.toBe(stages[0].trace.spanId);
    expect(events.find(e => e.type === "compaction_http_end" && e.trace.httpId === http[0].trace.httpId).trace).toEqual(http[0].trace);
    expect(events.find(e => e.type === "compaction_retry").trace).toEqual(stages[0].trace);
    const maintenance = events.filter(e => e.type.startsWith("auto_compaction_"));
    expect(maintenance[0].trace.epoch).toBe("next-epoch");
    expect(maintenance[1].trace).toEqual(maintenance[0].trace);
    expect(http[1].trace.parentSpanId).toBe(maintenance[0].trace.spanId);
    expect(http[1].trace.operationId).toBe(maintenance[0].trace.operationId);
  } finally {
    headersReady.resolve(new Response()); summaryReady.resolve();
    detach(); untraceHttp(); globalThis.fetch = originalFetch;
    await rm(directory, {recursive: true, force: true});
  }
});

test("native V2 retry warnings preserve explicit evidence without copying arbitrary logger context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-compaction-retry-"));
  const log = new EventLog(directory, {id: "compaction-retry", now: () => performance.now()});
  let epoch: string | undefined = "first-epoch";
  const dispose = installCompactionSpeculationTrace(log, () => ({epoch, modelCallId: "unrelated-model"}));
  const message = "V2 compaction attempt 1 failed, retrying in 1000ms";
  try {
    logger.debug(message, {error: "private-debug"});
    for (const unrelated of [`prefix ${message}`, `${message} suffix`, "V2 compaction attempt 0 failed, retrying in 1000ms"])
      logger.warn(unrelated, {error: "private-unrelated"});
    expect(await Bun.file(join(directory, "events.jsonl")).exists()).toBe(false);
    logger.warn(message, {model: "gpt-6.1-sol", error: "V2 compaction stream error (server_error): fixture failure",
      attempt: 999, retryDelayMs: 999, prompt: "private-prompt", headers: {authorization: "private-token"}});
    epoch = undefined;
    logger.warn("V2 compaction attempt 2 failed, retrying in 2000ms", {
      model: {name: "private-model"}, error: {message: "private-error"}, snapshotLeafId: "private-leaf",
    });
    const events = await lines(join(directory, "events.jsonl"));
    expect(events.map(event => event.type)).toEqual(["compaction_retry", "compaction_retry"]);
    expect(events[0].trace).toEqual({epoch: "first-epoch"});
    expect(events[0].data).toEqual({attempt: 1, retryDelayMs: 1000, model: "gpt-6.1-sol",
      error: "V2 compaction stream error (server_error): fixture failure"});
    expect(events[1].trace).toEqual({});
    expect(events[1].data).toEqual({attempt: 2, retryDelayMs: 2000});
    expect(JSON.stringify(events)).not.toContain("private-");
    dispose();
    logger.warn(message, {error: "detached"});
    expect(await lines(join(directory, "events.jsonl"))).toHaveLength(2);
  } finally { dispose(); await rm(directory, {recursive: true, force: true}); }
});

test("WS outbound frames are dispatch, not the first server event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-ws-trace-"));
  let now = 100;
  const log = new EventLog(directory, {id: "ws-trace", now: () => now});
  const trace = new ModelTrace(log, () => ({epoch: "epoch"}));
  const model = getBundledModels("openai-codex").find(m => m.id === "gpt-6.1-sol")!;
  const payload = {type: "response.create", previous_response_id: "previous", input: [{text: "中文"}]};
  const fixtureEnd = new Error("fixture ended after server event");
  const forwarded: string[] = [];
  const stream = trace.wrap(async (target, _context, options) => {
    expect(await options!.onPayload!(payload, target)).toBe(payload);
    now = 120;
    options!.onSseEvent!({event: "response.create", data: JSON.stringify(payload), raw: [": ws → response.create"]}, target);
    expect((await lines(join(directory, "events.jsonl"))).some(e => e.type === "model_stream_start")).toBe(false);
    now = 200;
    options!.onSseEvent!({event: "response.created", data: "{}", raw: [": ws ← response.created"]}, target);
    throw fixtureEnd;
  });
  try {
    await expect(stream(model, {messages: []}, {onSseEvent: e => forwarded.push(e.event!)})).rejects.toBe(fixtureEnd);
    const events = await lines(join(directory, "events.jsonl"));
    const request = events.find(e => e.type === "model_request");
    const dispatch = events.find(e => e.type === "model_ws_dispatch");
    const incoming = events.find(e => e.type === "model_stream_start");
    expect(request.data).toMatchObject({transport: "websocket", incremental: true,
      bodyBytes: Buffer.byteLength(JSON.stringify(payload))});
    expect(JSON.parse((await artifact(directory, request.data.payload)).toString())).toEqual(payload);
    expect(dispatch.trace).toEqual(request.trace);
    expect(incoming.data).toMatchObject({modelElapsedMs: 100, afterDispatchMs: 80});
    expect(forwarded).toEqual(["response.create", "response.created"]);
    expect(events.some(e => e.type.startsWith("model_http_"))).toBe(false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("compaction HTTP tracing forwards requests and responses without consuming bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-compaction-http-"));
  const log = new EventLog(directory, {id: "compaction", now: () => performance.now()});
  const original = globalThis.fetch;
  const calls: Parameters<typeof fetch>[] = [];
  const response = new Response("unread fixture", {status: 503, headers: {
    "server-timing": "queue;dur=10", "cf-ray": "ray-fixture", "set-cookie": "private-cookie",
  }});
  const fake = Object.assign(async (...args: Parameters<typeof fetch>) => { calls.push(args); return response; }, {preconnect: original.preconnect});
  globalThis.fetch = fake;
  const uninstall = installCompactionHttpTrace(log, () => ({epoch: "epoch-compaction"}));
  const endpoint = "https://chatgpt.com/backend-api/codex/responses";
  const headers = {"content-type": "application/json", authorization: "private-authorization",
    "x-codex-turn-metadata": JSON.stringify({request_kind: "compaction", session_id: "private-session", extra: {token: "private-metadata-token"}})};
  try {
    const excluded: Parameters<typeof fetch>[] = [
      [endpoint, {headers: {"x-codex-turn-metadata": JSON.stringify({request_kind: "turn"})}}],
      [endpoint, {headers: {"x-codex-turn-metadata": "malformed"}}],
      ["https://example.invalid/backend-api/codex/responses", {headers}],
      ["https://chatgpt.com/backend-api/codex/models", {headers}],
    ];
    for (const args of excluded) {
      expect(await fetch(...args)).toBe(response);
      expect(calls.at(-1)![0]).toBe(args[0]); expect(calls.at(-1)![1]).toBe(args[1]);
    }
    expect(await Bun.file(join(directory, "events.jsonl")).exists()).toBe(false);
    let streamReads = 0;
    const unknownBody = new ReadableStream<Uint8Array>({pull() { streamReads++; }}, {highWaterMark: 0});
    const request = new Request(endpoint, {method: "POST", headers, body: unknownBody});
    const directStream = new ReadableStream<Uint8Array>({pull() { streamReads++; }}, {highWaterMark: 0});
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const customInit = {method: "POST", headers, body: "测试", proxy: "http://private-proxy.invalid"};
    const included: Parameters<typeof fetch>[] = [
      [endpoint, customInit],
      [`${endpoint}/compact`, {method: "POST", headers, body: new Uint8Array([4, 5, 6]).buffer}],
      [endpoint, {method: "POST", headers, body: backing.subarray(1, 4)}],
      [endpoint, {method: "POST", headers, body: new DataView(backing.buffer, 2, 2)}],
      [request],
      [endpoint, {method: "POST", headers, body: directStream}],
    ];
    for (const args of included) {
      expect(await fetch(...args)).toBe(response);
      expect(calls.at(-1)![0]).toBe(args[0]); expect(calls.at(-1)![1]).toBe(args[1]);
    }
    expect(request.bodyUsed).toBe(false); expect(request.body!.locked).toBe(false);
    expect(directStream.locked).toBe(false); expect(streamReads).toBe(0);
    expect(response.bodyUsed).toBe(false); expect(response.body!.locked).toBe(false);
    expect(globalThis.fetch.preconnect).toBe(fake.preconnect);
    const events = await lines(join(directory, "events.jsonl"));
    const starts = events.filter(e => e.type === "compaction_http_start");
    const ends = events.filter(e => e.type === "compaction_http_end");
    expect(starts.map(e => e.data.bodyBytes)).toEqual([6, 3, 3, 2, undefined, undefined]);
    expect(starts).toHaveLength(6); expect(ends).toHaveLength(6);
    expect(new Set(starts.map(e => e.trace.httpId)).size).toBe(6);
    const expectedBodies = [Buffer.from("测试"), Buffer.from([4, 5, 6]), Buffer.from([1, 2, 3]), Buffer.from([2, 3])];
    for (let i = 0; i < expectedBodies.length; i++) {
      const saved = await artifact(directory, starts[i].data.body);
      expect(saved).toEqual(expectedBodies[i]!);
      expect(starts[i].data.body.bytes).toBe(saved.byteLength);
      expect(starts[i].data.body.sha256).toBe(new Bun.SHA256().update(saved).digest("hex"));
    }
    expect(starts[4].data).not.toHaveProperty("body");
    expect(starts[5].data).not.toHaveProperty("body");
    for (let i = 0; i < starts.length; i++) {
      expect(starts[i].trace.epoch).toBe("epoch-compaction");
      expect(ends[i].trace).toEqual(starts[i].trace);
      expect(ends[i].data).toMatchObject({status: 503, headers: {"server-timing": "queue;dur=10", "cf-ray": "ray-fixture"}});
      expect(ends[i].data.fetchToHeadersMs).toBeGreaterThanOrEqual(0);
      expect(ends[i].data.fetchToHeadersMs).toBeLessThanOrEqual(ends[i].data.durationMs);
      expect(starts[i].data).not.toHaveProperty("headers");
    }
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(events.some(e => e.type.startsWith("model_"))).toBe(false);
    uninstall(); expect(globalThis.fetch).toBe(fake);
    await fetch(...included[0]!);
    expect(await lines(join(directory, "events.jsonl"))).toHaveLength(12);
  } finally { uninstall(); globalThis.fetch = original; await rm(directory, {recursive: true, force: true}); }
});

test("compaction HTTP failures and cancellation retain safe diagnostics and independent IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-compaction-error-"));
  const log = new EventLog(directory, {id: "compaction", now: () => performance.now()});
  const original = globalThis.fetch;
  const cause = Object.assign(new Error("unable to verify certificate"), {code: "CERT_UNTRUSTED", token: "private-cause-token"});
  const failure = Object.assign(new TypeError("certificate verification error", {cause}), {headers: {authorization: "private-error-header"}});
  const abort = new DOMException("Cancelled", "AbortError");
  const entered = Promise.withResolvers<void>();
  let attempts = 0;
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (++attempts === 1) throw failure;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(abort), {once: true}));
  }, {preconnect: original.preconnect});
  const uninstall = installCompactionHttpTrace(log);
  const endpoint = "https://chatgpt.com/backend-api/codex/responses";
  const init = {method: "POST", headers: {"x-codex-turn-metadata": '{"request_kind":"compaction"}'}, body: "fixture"};
  try {
    await expect(fetch(endpoint, init)).rejects.toBe(failure);
    const control = new AbortController();
    const pending = fetch(endpoint, {...init, signal: control.signal});
    await entered.promise; control.abort();
    await expect(pending).rejects.toBe(abort);
    const events = await lines(join(directory, "events.jsonl"));
    const starts = events.filter(e => e.type === "compaction_http_start");
    const errors = events.filter(e => e.type === "compaction_http_error");
    expect(errors).toHaveLength(2);
    expect(errors[0].data).toMatchObject({error: "TypeError: certificate verification error", aborted: false,
      cause: {name: "Error", code: "CERT_UNTRUSTED", message: "unable to verify certificate"}});
    expect(errors[0].data).not.toHaveProperty("code");
    expect(errors[1].data).toMatchObject({error: "AbortError: Cancelled", aborted: true});
    expect(errors[0].trace).toEqual(starts[0].trace); expect(errors[1].trace).toEqual(starts[1].trace);
    expect(errors[0].trace.httpId).not.toBe(errors[1].trace.httpId);
    expect(events.filter(e => e.type === "compaction_http_end")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("private-");
  } finally { uninstall(); globalThis.fetch = original; await rm(directory, {recursive: true, force: true}); }
});

test("real OMP preserves image prefixes and native tool traces while shell IPC retains only its declared epoch", async () => {
  const globalProvider = otelTrace.getTracerProvider();
  const directory = await mkdtemp(join(tmpdir(), "rsa-wire-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), {recursive: true});
  const notes = join(workspace, "skills", "notes.md");
  await Bun.write(notes, "first line\nsecond line\nthird line\n");
  const image = join(directory, "sample.png");
  await Bun.write(image, Buffer.from(png, "base64"));
  const log = new EventLog(directory, {id: "wire-test", now: () => performance.now()});
  let samples = 0;
  const core = new BasewareCore({ record: log.record, drivers: [{id: "trace-fixture", version: "1"}], capabilities: {controllers: [{tool: { name: "joint-7", description: "move <n>", inputSchema: { type: "object" } }, requiresControl: true,  acquire: async () => {}, release: async () => {},
    async execute(args) { return {id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: JSON.stringify(args), stderr: "", result: { content: [] },
      timing: {clock: "wire-test", requestedAtMs: performance.now(), receivedAtMs: performance.now()}}; },
  }, {tool: { name: "camera-q", description: "sample", inputSchema: { type: "object" } }, requiresControl: false,  mediaTypes: ["image/png"], async execute() {
    return captureResult([{id: `observation-${++samples}`, controllerId: "camera-q", mediaType: "image/png", path: image,
      sourceSequence: samples * 100,
      timing: {clock: "wire-test", requestedAtMs: performance.now(), receivedAtMs: performance.now()}}]);
  }}]} });
  const basewareSocket = `/tmp/baseware-wire-${crypto.randomUUID()}.sock`;
  const closeSocket = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({socket: basewareSocket, seconds: 300, runDir: directory, record: log.record});
  const runtime = new Runtime(devices, log.record);
  runtime.controller = new WorkspaceController({ workspace, devices, record: log.record, env: {} });
  installTestPerception(runtime, workspace, directory, (signal, trace) =>
    readTestController(runtime, "camera-q", {}, signal, trace));
  devices.onHandback(reason => { void runtime.stop(reason); });
  devices.onDisconnect(error => { void runtime.disconnected(error); });
  const {epoch} = await runtime.start();
  const trace = new ModelTrace(log, () => ({epoch: epoch!, ...extension.context()}));
  const extension = createRsaExtension({runtime, workspace: new Workspace(workspace, join(directory, "skill-versions")), basewareSocket,
    binDir: resolve(import.meta.dir, "../bin"),
    cycle: () => ({epoch: epoch!, signal: new AbortController().signal}), maxRequests: 7, trace: trace.current});
  const received: string[] = [];
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push(await request.text());
    const delta = received.length === 1 ? {role: "assistant", content: "", reasoning_content: "probe",
      tool_calls: [1, 2].map((n, index) => ({index, id: `tool-${n}`, type: "function", function: {name: "bash", arguments: JSON.stringify({command: `baseware controller joint-7 --args '{"distance":${n}}'`})}}))}
      : received.length < 7 ? {role: "assistant", content: "", reasoning_content: "probe",
        tool_calls: [{index: 0, id: `round-${received.length}`, type: "function", function: received.length === 6
          ? {name: "read", arguments: JSON.stringify({path: "skills/notes.md:2-3"})}
          : received.length === 5 ? {name: "observe", arguments: "{}"}
          : {name: "bash", arguments: JSON.stringify({command: `printf sample-${received.length}`})}}]}
      : {role: "assistant", content: "done"};
    return new Response(sse(delta, received.length < 7 ? "tool_calls" : "stop", `response-${received.length}`), {
      headers: {"Content-Type": "text/event-stream", "x-request-id": `http-${received.length}`, "set-cookie": "private-response-cookie",
        "server-timing": "queue;dur=12.5", "cf-ray": `ray-${received.length}`},
    });
  }});
  const settings = Settings.isolated({"memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false, "retry.modelFallback": false, "title.refreshOnReplan": false});
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("deepseek", "private-fake-api-key");
  const registry = new ModelRegistry(auth, undefined, {settings});
  const model = {...registry.find("deepseek", "deepseek-flash")!, baseUrl: `http://127.0.0.1:${server.port}`};
  const {session} = await createOmpSession({cwd: workspace, agentDir: join(directory, "omp"), model, settings,
    authStorage: auth, modelRegistry: registry, sessionManager: SessionManager.create(workspace, join(directory, "session")), telemetry: trace.shiori.config,
    systemPrompt: "Use the supplied tools.", cacheWarming: false, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, disableExtensionDiscovery: true,
    restrictToolNames: true, allowRestrictedCustomTools: true, toolNames: ["bash", "read", "observe"], customTools: extension.tools,
    preloadedPreparedExtensions: [{path: "trace-test", resolvedPath: "trace-test", factory: (pi) => {
      extension.factory(pi);
      pi.on("before_provider_request", event => ({...event.payload as object, diagnostic_marker: "after-extension"}));
    }, error: null}],
  });
  const detach = trace.attach(session);
  try {
    await session.prompt("Probe.");
    expect(received).toHaveLength(7);
    const bodies = received.map(body => JSON.parse(body));
    expect(bodies.map(body => body.messages.flatMap((message: {content: unknown}) => Array.isArray(message.content) ? message.content : [])
      .filter((part: {type: string}) => part.type === "image_url").length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i].messages.slice(0, bodies[i - 1].messages.length)).toEqual(bodies[i - 1].messages);
    }
    const events = await lines(join(directory, "events.jsonl"));
    const requests = events.filter(e => e.type === "model_request");
    const http = events.filter(e => e.type === "model_http_start");
    const ends = events.filter(e => e.type === "model_end");
    const dispatches = events.filter(e => e.type === "model_http_dispatch");
    const headers = events.filter(e => e.type === "model_http_end");
    const streamStarts = events.filter(e => e.type === "model_stream_start");
    expect(requests).toHaveLength(7); expect(http).toHaveLength(7); expect(ends).toHaveLength(7);
    expect(dispatches).toHaveLength(7); expect(streamStarts).toHaveLength(7);
    for (let i = 0; i < received.length; i++) {
      const wire = await artifact(directory, http[i].data.body);
      expect(wire.toString()).toBe(received[i]);
      expect(new Bun.SHA256().update(wire).digest("hex")).toBe(http[i].data.body.sha256);
      expect(JSON.parse((await artifact(directory, requests[i].data.payload)).toString())).toEqual(JSON.parse(received[i]));
      expect(JSON.parse(received[i]).diagnostic_marker).toBe("after-extension");
      expect(http[i].trace.requestId).toBe(requests[i].trace.requestId);
      expect(ends[i].trace.modelCallId).toBe(requests[i].trace.modelCallId);
      expect(ends[i].data.usage).toMatchObject({input: 210, cacheRead: 1024, output: 2});
      expect(dispatches[i].trace.httpId).toBe(http[i].trace.httpId);
      expect(dispatches[i].atMs).toBeLessThanOrEqual(headers[i].atMs);
      expect(headers[i].atMs).toBeLessThanOrEqual(streamStarts[i].atMs);
      expect(headers[i].data.fetchToHeadersMs).toBeGreaterThanOrEqual(0);
      expect(headers[i].data.fetchToHeadersMs).toBeLessThanOrEqual(headers[i].data.durationMs);
      expect(headers[i].data.headers).toMatchObject({"server-timing": "queue;dur=12.5", "cf-ray": `ray-${i + 1}`});
      expect(ends[i].data.firstStreamEventMs).toBeGreaterThanOrEqual(0);
      expect(ends[i].data.payloadCaptureMs).toBeGreaterThanOrEqual(0);
      expect(ends[i].data.httpInspectionMs).toBeGreaterThanOrEqual(0);
    }
    const nativeStarts = events.filter(e => e.type === "shiori_span_start");
    const nativeEnds = events.filter(e => e.type === "shiori_span_end");
    const nativeRun = nativeStarts.find(e => e.data.operation === "invoke_agent");
    const nativeChats = nativeStarts.filter(e => e.data.operation === "chat");
    const nativeTools = nativeStarts.filter(e => e.data.operation === "execute_tool");
    expect(nativeRun.trace.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(nativeRun.trace.traceId).not.toBe("0".repeat(32));
    expect(nativeChats).toHaveLength(7);
    expect(nativeTools).toHaveLength(7);
    expect(nativeEnds).toHaveLength(nativeStarts.length);
    for (const event of nativeStarts) {
      expect(event.source).toEqual(SHIORI_SOURCE);
      expect(event.trace.epoch).toBe(epoch);
      expect(event.trace.traceId).toBe(nativeRun.trace.traceId);
      expect(event.trace.spanId).toMatch(/^[a-f0-9]{16}$/);
      const end = nativeEnds.find(e => e.trace.spanId === event.trace.spanId);
      expect(end.data.durationMs).toBeGreaterThanOrEqual(0);
      expect(end.data.outcome).toBe("success");
      if (event !== nativeRun) expect(event.trace.parentSpanId).toBe(nativeRun.trace.spanId);
    }
    const summaries = events.filter(e => e.type === "shiori_run_end");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].data).toMatchObject({ scope: "agent_loop", summary: {chats: {total: 7}, tools: {total: 7, ok: 7}},
      coverage: {toolsAvailable: ["bash", "observe", "read"], toolsInvoked: ["bash", "observe", "read"]} });
    expect(summaries[0].trace.spanId).toBe(nativeRun.trace.spanId);
    expect(otelTrace.getTracerProvider()).toBe(globalProvider);
    for (const [index, request] of requests.entries()) {
      expect(request.source).toEqual(SHIORI_SOURCE);
      expect(request.trace.spanId).toBe(nativeChats[index].trace.spanId);
    }
    expect(JSON.stringify(nativeEnds)).not.toContain("gen_ai.input.messages");
    expect(JSON.stringify(nativeEnds)).not.toContain("gen_ai.tool.call.arguments");
    const firstCall = requests[0].trace.modelCallId;
    for (const tool of ["tool-1", "tool-2"]) {
      for (const type of ["tool_start", "tool_end"]) {
        const event = events.find(e => e.type === type && e.trace.toolCallId === tool);
        expect(event, `${tool} ${type}`).toBeDefined();
        expect(event.trace).toMatchObject({epoch, modelCallId: firstCall, requestId: requests[0].trace.requestId});
      }
    }
    for (const tool of nativeTools) {
      for (const type of ["tool_start", "tool_end"]) {
        const event = events.find(e => e.type === type && e.trace.toolCallId === tool.trace.toolCallId);
        expect(event.trace.spanId, `${type} native parent`).toBe(tool.trace.spanId);
      }
    }
    const firstBatchEnd = events.filter(e => e.type === "tool_end" && e.trace.modelCallId === firstCall).at(-1)!;
    const observations = events.flatMap(e => e.type === "execution"
      ? (e.data.observations ?? []).map((data: unknown) => ({...e, type: "observation", data}))
      : e.type === "observation" ? [e] : []);
    expect(observations.filter(e => e.trace.modelCallId === firstCall)
      .map(e => e.trace.toolCallId)).toEqual([firstBatchEnd.trace.toolCallId]);
    expect(observations[0].data.origin).toBe("cli");
    expect(observations[1].data).toMatchObject({origin: "cli", sourceSequenceDelta: 100,
      previousObservationId: "observation-1"});
    const perceptionReads = events.filter(e => e.type === "perception_observe_end");
    expect(perceptionReads).toHaveLength(7);
    const deliveries = events.filter(e => e.type === "observation_context");
    const deliveryStarts = events.filter(e => e.type === "model_start");
    expect(deliveryStarts.flatMap(start => start.data.deliveryIds)).toEqual(deliveries.map(delivery => delivery.data.id));
    expect(deliveries.flatMap(delivery => delivery.data.queries)).toEqual(perceptionReads.map(read => read.data.queryId));

    expect(perceptionReads[1].trace).toMatchObject({epoch, modelCallId: firstCall, toolCallId: firstBatchEnd.trace.toolCallId});
    expect(perceptionReads[1].data.records.flatMap((record: {media: {id: string}[]}) => record.media.map(value => value.id))).toEqual(["observation-2"]);
    expect(perceptionReads[1].data.durationMs).toBeGreaterThanOrEqual(0);
    const explicitObserve = nativeTools.find(e => e.trace.toolCallId === "round-5");
    expect(perceptionReads[5].trace).toMatchObject({ epoch, modelCallId: requests[4].trace.modelCallId,
      toolCallId: "round-5", traceId: explicitObserve.trace.traceId });
    expect(observations[5].trace).toMatchObject({ modelCallId: requests[4].trace.modelCallId,
      toolCallId: "round-5", traceId: explicitObserve.trace.traceId });
    // This fixture's sampling uses no control lease; Runtime does not propagate
    // an epoch to the raw device call, but keeps its explicit native ancestry.
    expect(observations[5].trace).not.toHaveProperty("epoch");
    expect(events.filter(e => e.type === "observation_media")).toHaveLength(7);
    expect(events.find(e => e.type === "read").data).toMatchObject({
      requestedPath: "skills/notes.md:2-3", path: notes, isError: false,
      hash: new Bun.SHA256().update(await Bun.file(notes).arrayBuffer()).digest("hex"),
    });
    const commands = events.filter(e => e.type === "command" && e.data.requiresControl);
    expect(commands.map(e => e.trace.operationId)).toHaveLength(2);
    expect(events.filter(e => e.type === "command" && e.data.requiresControl === false)).toHaveLength(7);
    expect(new Set(commands.map(e => e.trace.traceId)).size).toBe(2);
    expect(commands.map(e => e.data.arguments).sort((a, b) => a.distance - b.distance)).toEqual([{distance: 1}, {distance: 2}]);
    for (const command of commands) {
      expect(command.trace.epoch).toBe(epoch);
      expect(command.trace.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(command.trace.spanId).toMatch(/^[a-f0-9]{16}$/);
      expect(command.trace.traceId).not.toBe(nativeRun.trace.traceId);
      for (const key of ["modelCallId", "toolCallId", "requestId", "parentSpanId"])
        expect(command.trace).not.toHaveProperty(key);
      const execution = events.find(e => e.type === "execution" && e.trace.operationId === command.trace.operationId);
      expect(execution.trace).toEqual(command.trace);
      expect(execution.source.component).toBe("baseware");
      expect(execution.origin.clockId).toBe(command.origin.clockId);
    }
    expect(events.filter(e => e.type === "execution").map(e => e.trace.operationId))
      .toEqual(events.filter(e => e.type === "command").map(e => e.trace.operationId));
    const starts = events.filter(e => e.type === "model_start");
    expect(starts[1].data.observations).toEqual(["observation-2"]);
    const contexts = events.filter(e => e.type === "context");
    expect(contexts[1].data.observations).toEqual(starts[1].data.observations);
    expect(contexts[1].data.deliveryIds).toEqual(starts[1].data.deliveryIds);
    expect(deliveries.find(delivery => delivery.data.id === starts[1].data.deliveryIds[0])?.data.queries)
      .toEqual([perceptionReads[1].data.queryId]);
    const raw = await readFile(join(directory, starts[0].data.streamPath), "utf8");
    expect(raw).toContain("kept-raw");
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain("private-fake-api-key");
    expect(eventText).not.toContain("private-response-cookie");
  } finally {
    detach(); await session.dispose(); await trace.shiori.close(); auth.close(); await runtime.close(); devices.close(); await closeSocket();
    server.stop(true); await rm(directory, {recursive: true, force: true});
  }
}, 30_000);

test("HTTP errors and cancellation have terminal model events and preserve their request identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-errors-"));
  const log = new EventLog(directory, {id: "errors", now: () => performance.now()});
  const trace = new ModelTrace(log, () => ({epoch: "epoch"}));
  const stream = trace.wrap(streamOpenAICompletions as StreamFn);
  const model = getBundledModels("deepseek").find(m => m.id === "deepseek-flash")!;
  try {
    const response = await stream(model, {messages: [{role: "user", content: "test", timestamp: 0}]}, {
      apiKey: "fake-private", fetch: async () => Response.json({error: {message: "fixture rejected request", type: "invalid_request_error"}}, {status: 400}),
    });
    expect((await response.result()).stopReason).toBe("error");
    const entered = Promise.withResolvers<void>();
    const control = new AbortController();
    const cancelled = await stream(model, {messages: [{role: "user", content: "cancel", timestamp: 0}]}, {
      apiKey: "fake-private", signal: control.signal,
      fetch: async (_input, init) => { entered.resolve(); return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
      }); },
    });
    await entered.promise; control.abort();
    expect((await cancelled.result()).stopReason).toBe("aborted");
    const events = await lines(join(directory, "events.jsonl"));
    const ends = events.filter(e => e.type === "model_end");
    expect(ends.map(e => e.data.stopReason)).toEqual(["error", "aborted"]);
    const failure = events.find(e => e.type === "model_http_end");
    expect(failure.data.status).toBe(400);
    expect((await artifact(directory, failure.data.errorBody)).toString()).toContain("fixture rejected request");
    expect((await artifact(directory, ends[0].data.response)).toString()).not.toContain("fake-private");
    expect(events.find(e => e.type === "model_http_error").trace.requestId).toBe(ends[1].trace.requestId);
    expect(events.filter(e => e.type === "model_http_start")).toHaveLength(2);
  } finally { await rm(directory, {recursive: true, force: true}); }
}, 30_000);

test("certificate fetch errors record only diagnostic fields and retain HTTP correlation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-certificate-"));
  const log = new EventLog(directory, {id: "certificate", now: () => performance.now()});
  const trace = new ModelTrace(log, () => ({epoch: "epoch"}));
  const cause = Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", token: "private-cause-token", headers: {authorization: "private-cause-header"},
  });
  const failure = Object.assign(new TypeError("unknown certificate verification error", {cause}), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID", options: {apiKey: "private-option-key"}, credential: "private-credential",
  });
  const stream = trace.wrap(async (model, _context, options) => {
    const payload = {model: model.id, input: "certificate fixture"};
    await options!.onPayload!(payload, model);
    await options!.fetch!("https://fixture.invalid/responses", {
      method: "POST", body: JSON.stringify(payload), headers: {authorization: "private-request-token"},
    });
    throw new Error("Fixture fetch should have thrown");
  });
  const model = getBundledModels("deepseek").find(m => m.id === "deepseek-flash")!;
  try {
    await expect(stream(model, {messages: []}, {fetch: async () => { throw failure; }})).rejects.toBe(failure);
    const events = await lines(join(directory, "events.jsonl"));
    const request = events.find(e => e.type === "model_request");
    const http = events.find(e => e.type === "model_http_start");
    const error = events.find(e => e.type === "model_http_error");
    const end = events.find(e => e.type === "model_end");
    expect(error.data).toMatchObject({error: "TypeError: unknown certificate verification error",
      code: "ERR_TLS_CERT_ALTNAME_INVALID", aborted: false,
      cause: {name: "Error", code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate"}});
    expect(error.trace).toEqual(http.trace);
    expect(error.trace.requestId).toBe(request.trace.requestId);
    expect(error.trace.modelCallId).toBe(request.trace.modelCallId);
    expect(end.trace).toEqual(error.trace);
    expect(end.data.stopReason).toBe("error");
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(events.filter(e => e.type === "model_http_end")).toHaveLength(0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("transport retries share a request but get distinct HTTP IDs; reused tool IDs belong to the new call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-retry-"));
  const log = new EventLog(directory, {id: "retry", now: () => performance.now()});
  const trace = new ModelTrace(log, () => ({epoch: "epoch"}));
  const stream = trace.wrap(streamOpenAICompletions as StreamFn);
  const model = getBundledModels("deepseek").find(m => m.id === "deepseek-flash")!;
  let attempts = 0;
  const fetch = async () => {
    if (++attempts === 1) return Response.json({error: {message: "retry fixture"}}, {status: 503, headers: {"retry-after": "0"}});
    return new Response(sse({role: "assistant", content: "", reasoning_content: "probe", tool_calls: [{index: 0, id: "reused-tool", type: "function", function: {name: "bash", arguments: "{}"}}]}, "tool_calls", `response-${attempts}`), {headers: {"content-type": "text/event-stream"}});
  };
  try {
    const context = {messages: [{role: "user" as const, content: "test", timestamp: 0}], tools: [{name: "bash", description: "probe", parameters: {type: "object", properties: {}}}]};
    await (await stream(model, context, {apiKey: "fake", fetch})).result();
    const first = trace.current("reused-tool");
    await (await stream(model, context, {apiKey: "fake", fetch})).result();
    const second = trace.current("reused-tool");
    expect(second.modelCallId).not.toBe(first.modelCallId);
    const events = await lines(join(directory, "events.jsonl"));
    const requests = events.filter(e => e.type === "model_request");
    const http = events.filter(e => e.type === "model_http_start");
    expect(requests).toHaveLength(2); expect(http).toHaveLength(3);
    expect(http[0].trace.requestId).toBe(http[1].trace.requestId);
    expect(http[0].trace.httpId).not.toBe(http[1].trace.httpId);
    expect(http[0].data.body.sha256).toBe(http[1].data.body.sha256);
    expect(events.filter(e => e.type === "model_end").map(e => e.data.httpAttempts)).toEqual([2, 1]);
  } finally { await rm(directory, {recursive: true, force: true}); }
}, 30_000);
