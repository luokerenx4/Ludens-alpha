import { expect, spyOn, test } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type as schema } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { scheduler } from "node:timers/promises";
import {
  getOpenAICodexTransportDetails,
  resetOpenAICodexHistoryAfterCompaction,
  streamOpenAICodexResponses,
  type OpenAICodexResponsesOptions,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";

/**
 * External OMP transport contract tests: architecture-development TDD exception.
 * Production seed: Mario Maker 8h run 2026-10-19T13-19-53.903Z, explicit expiry
 * recovered at 23:21 Asia/Shanghai, but close(1012) at 23:46:56 stayed on SSE.
 * Boundary correction: run 2026-10-20T14-57-50.713Z expired while a custom
 * tool's input was incomplete; restore OMP's native toolcall_end commit point.
 * The close-code/partial-output/cancellation matrix below is fault injection,
 * not a claim that each condition occurred in that run. No live model or auth.
 * Policy and condition catalogue: ./README.md.
 */

const frameLimit = 15 * 1024 * 1024;
const model = buildModel({
  id: "gpt-6.1-sol", name: "Offline Codex fixture", api: "openai-codex-responses",
  provider: "openai-codex", baseUrl: "http://127.0.0.1:9", reasoning: true,
  preferWebsockets: true, input: ["text"], contextWindow: 256000, maxTokens: 4096,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
});
// Synthetic token only: neither the fixture nor the provider reads local auth.
const apiKey = `aaa.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": {chatgpt_account_id: "rsa-offline-test"},
})).toString("base64url")}.bbb`;
const user = (content: string) => ({role: "user" as const, content, timestamp: 1});
const context = (content: string): Context => ({messages: [user(content)]});

function completedEvents(id: string) {
  const item = {type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
    content: [{type: "output_text", text: "OK"}]};
  return [
    {type: "response.created", response: {id}},
    {type: "response.output_item.added", item: {...item, status: "in_progress", content: []}},
    {type: "response.content_part.added", part: {type: "output_text", text: ""}},
    {type: "response.output_text.delta", delta: "OK"},
    {type: "response.output_item.done", item},
    {type: "response.completed", response: {id, status: "completed", usage: {
      input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: {cached_tokens: 0},
    }}},
  ];
}

type Payload = Record<string, unknown>;
function decodeBody(body: RequestInit["body"]): Payload {
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(body)));
  throw new Error("Expected the provider's serialized SSE request body");
}

function inputTexts(body: Payload): string[] {
  return (body.input as Array<{content?: Array<{type: string; text?: string}>}>)
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === "input_text")
    .map(part => part.text!);
}

/** Both transports are local doubles; even an unexpected fallback cannot make a network request. */
function fixture() {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const websocketEnv = Bun.env.PI_CODEX_WEBSOCKET;
  const installId = spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
  Bun.env.PI_CODEX_WEBSOCKET = "1";
  const state = new Map<string, ProviderSessionState>();
  const sessionId = crypto.randomUUID();
  const sockets: FakeSocket[] = [];
  const frames: string[] = [];
  const http: Payload[] = [];
  let handshakeCloseCode: number | undefined;
  let stallNextHandshake = false;
  let onSend = (socket: FakeSocket) => {
    for (const event of completedEvents(`ws_${frames.length}`)) socket.message(event);
  };
  let onHttp: () => object[] = () => completedEvents(`sse_${http.length}`);
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    bufferedAmount = 0;
    binaryType = "nodebuffer";
    onopen?: (event: object) => void;
    onclose?: (event: {code: number; reason: string}) => void;
    onerror?: (event: object) => void;
    onmessage?: (event: {data: string}) => void;
    constructor() {
      sockets.push(this);
      if (stallNextHandshake) {
        stallNextHandshake = false;
        return;
      }
      queueMicrotask(() => {
        if (this.readyState !== FakeSocket.CONNECTING) return;
        if (handshakeCloseCode !== undefined) {
          this.remoteClose(handshakeCloseCode);
          return;
        }
        this.readyState = FakeSocket.OPEN;
        this.onopen?.({});
      });
    }
    send(data: string) { frames.push(data); onSend(this); }
    message(value: object) { this.onmessage?.({data: JSON.stringify(value)}); }
    raw(data: string) { this.onmessage?.({data}); }
    remoteClose(code: number) {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({code, reason: "injected close"});
    }
    fail(message: string) { this.onerror?.({message}); }
    expire() {
      this.message({type: "error", code: "websocket_connection_limit_reached",
        message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."});
    }
    rejectSize() {
      this.remoteClose(1009);
    }
    close() { this.readyState = FakeSocket.CLOSED; }
  }
  const fetch: FetchImpl = async (_input, init) => {
    http.push(decodeBody(init?.body));
    return new Response(onHttp()
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {headers: {"content-type": "text/event-stream"}});
  };
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(fetch, {preconnect: originalFetch.preconnect}) as typeof globalThis.fetch;
  const options: OpenAICodexResponsesOptions = {
    apiKey, fetch, providerSessionState: state, sessionId, preferWebsockets: true,
  };
  return {
    sockets, frames, http,
    failHandshake(code = 1002) { handshakeCloseCode = code; },
    restoreHandshake() { handshakeCloseCode = undefined; },
    stallNextHandshake() { stallNextHandshake = true; },
    onSend(callback: typeof onSend) { onSend = callback; },
    onHttp(callback: typeof onHttp) { onHttp = callback; },
    stream(input: Context, extra: OpenAICodexResponsesOptions = {}) {
      return streamOpenAICodexResponses(model, input, {...options, ...extra});
    },
    details() { return getOpenAICodexTransportDetails(model, options); },
    compact() {
      resetOpenAICodexHistoryAfterCompaction({providerSessionState: state, sessionId, compaction: {
        operationId: crypto.randomUUID(), trigger: "auto", reason: "context_limit",
        phase: "pre_turn", strategy: "memento",
      }});
    },
    close() {
      for (const provider of state.values()) provider.close();
      state.clear();
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
      if (websocketEnv === undefined) delete Bun.env.PI_CODEX_WEBSOCKET;
      else Bun.env.PI_CODEX_WEBSOCKET = websocketEnv;
      installId.mockRestore();
    },
  };
}

test("expiry during custom tool input recovers through the native Agent and executes the completed tool once", async () => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  const executed: string[] = [];
  const input = "record the first pit";
  const parameters = schema({input: "string"});
  const tool: AgentTool<typeof parameters> = {
    name: "record", label: "Record", description: "Record text in the offline fixture.",
    parameters, intent: "omit", customWireName: "record",
    customFormat: {syntax: "regex", definition: ".+"},
    async execute(_id, args) {
      executed.push(args.input);
      return {content: [{type: "text", text: "recorded"}], details: {}};
    },
  };
  const agent = new Agent({
    initialState: {model, tools: [tool]},
    streamFn: (_model, input, options) => f.stream(input, {signal: options?.signal}),
  });
  try {
    f.onSend(socket => {
      socket.message({type: "response.created", response: {id: "ws_interrupted"}});
      socket.message({type: "response.output_item.added", output_index: 0, item: {
        type: "custom_tool_call", id: "ct_partial", call_id: "call_partial", name: "record", input: "",
      }});
      socket.message({type: "response.custom_tool_call_input.delta",
        item_id: "ct_partial", output_index: 0, delta: "record the first"});
      // Production failure: input was still streaming, so no toolcall_end and
      // no executable call had been handed to the native Agent.
      socket.expire();
    });
    f.onHttp(() => {
      if (f.http.length > 1) return completedEvents(`sse_${f.http.length}`);
      const item = {type: "custom_tool_call", id: "ct_complete",
        call_id: "call_complete", name: "record", input};
      return [
        {type: "response.created", response: {id: "sse_tool"}},
        {type: "response.output_item.added", output_index: 0, item: {...item, input: ""}},
        {type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: 0, delta: input},
        {type: "response.custom_tool_call_input.done", item_id: item.id, output_index: 0, input},
        {type: "response.output_item.done", output_index: 0, item},
        {type: "response.completed", response: {id: "sse_tool", status: "completed",
          usage: {input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: {cached_tokens: 0}}}},
      ];
    });

    await agent.prompt("record a step");
    expect(executed).toEqual([input]);
    expect(agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
    expect(agent.state.messages.at(-1)).toMatchObject({role: "assistant", stopReason: "stop"});
    expect(f.frames).toHaveLength(1);
    // Native Agent dispatches the recovered call, then sends its result during
    // the same prompt. Both requests use SSE while the socket is cooling down.
    expect(f.http).toHaveLength(2);
    expect(f.http[1]!.input).toContainEqual(expect.objectContaining({
      type: "custom_tool_call_output", call_id: "call_complete", output: "recorded",
    }));
    expect(f.details()).toMatchObject({websocketDisabled: false, retryWebsocketAt: now + 60_000});

    now += 60_001;
    f.onSend(socket => { for (const event of completedEvents(`ws_${f.frames.length}`)) socket.message(event); });
    await agent.prompt("recover websocket");
    expect(f.sockets).toHaveLength(2);
    expect(f.http).toHaveLength(2);
    expect(JSON.parse(f.frames[1]!).previous_response_id).toBeUndefined();
    await agent.prompt("next delta");
    const delta = JSON.parse(f.frames[2]!) as Payload;
    expect(delta.previous_response_id).toBe("ws_2");
    expect(inputTexts(delta)).toEqual(["next delta"]);
    expect(executed).toEqual([input]);
  } finally { agent.abort(); dateNow.mockRestore(); f.close(); }
});

test("oversize UTF-8 websocket frame falls back to complete SSE and stays blocked until compaction", async () => {
  const f = fixture();
  // Below 15 MiB in JS characters, above 15 MiB on the wire.
  const text = "界".repeat(frameLimit / 3 + 16);
  const initial = context(text);
  try {
    const first = await f.stream(initial).result();
    expect(first.stopReason).toBe("stop");
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(1);
    expect(f.http[0]!.previous_response_id).toBeUndefined();
    expect(inputTexts(f.http[0]!)[0] === text).toBe(true);
    const connections = f.sockets.length;
    const second = await f.stream({messages: [...initial.messages, first, user("continue")]}).result();
    expect(second.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(connections);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(2);
    expect(f.http[1]!.previous_response_id).toBeUndefined();
    const texts = inputTexts(f.http[1]!);
    expect(texts[0] === text).toBe(true);
    expect(texts.at(-1)).toBe("continue");
  } finally { f.close(); }
});

test("small delta frames reuse websocket even when accumulated full history exceeds 15 MiB", async () => {
  const f = fixture();
  const initial = context("a".repeat(14 * 1024 * 1024));
  try {
    const first = await f.stream(initial).result();
    expect(first.stopReason).toBe("stop");
    const secondContext: Context = {messages: [...initial.messages, first, user("b".repeat(2 * 1024 * 1024))]};
    const second = await f.stream(secondContext).result();
    expect(second.stopReason).toBe("stop");
    const third = await f.stream({messages: [...secondContext.messages, second, user("small delta")]}).result();
    expect(third.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.http).toHaveLength(0);
    expect(f.frames).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(secondContext))).toBeGreaterThan(frameLimit);
    for (const frame of f.frames) expect(Buffer.byteLength(frame)).toBeLessThan(frameLimit);
    const requests = f.frames.map(frame => JSON.parse(frame) as Payload);
    expect(requests[0]!.previous_response_id).toBeUndefined();
    expect(requests[1]!.previous_response_id).toBe("ws_1");
    expect(requests[2]!.previous_response_id).toBe("ws_2");
    expect(requests[1]!.input).toHaveLength(1);
    expect(inputTexts(requests[2]!)).toEqual(["small delta"]);
  } finally { f.close(); }
});

test("a replacement websocket starts with full history before resuming delta requests", async () => {
  const f = fixture();
  const initial = context("first question");
  try {
    const first = await f.stream(initial).result();
    const secondContext: Context = {messages: [...initial.messages, first, user("second question")]};
    const second = await f.stream(secondContext).result();
    expect(second.stopReason).toBe("stop");
    expect(JSON.parse(f.frames[1]!).previous_response_id).toBe("ws_1");

    // The server-side connection is gone, while the client still remembers its last response.
    f.sockets[0]!.close();
    const thirdContext: Context = {messages: [...secondContext.messages, second, user("third question")]};
    const third = await f.stream(thirdContext).result();
    expect(third.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(3);
    expect(f.http).toHaveLength(0);
    const bootstrap = JSON.parse(f.frames[2]!) as Payload;
    expect(bootstrap.previous_response_id).toBeUndefined();
    expect(inputTexts(bootstrap)).toEqual(["first question", "second question", "third question"]);

    const fourth = await f.stream({messages: [...thirdContext.messages, third, user("fourth question")]}).result();
    expect(fourth.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(4);
    expect(f.http).toHaveLength(0);
    const delta = JSON.parse(f.frames[3]!) as Payload;
    expect(delta.previous_response_id).toBe("ws_3");
    expect(inputTexts(delta)).toEqual(["fourth question"]);
  } finally { f.close(); }
});

test("remote 1009 sends once, replays complete history over SSE, and blocks later websocket handshakes", async () => {
  const f = fixture();
  const initial = context("first question");
  try {
    const first = await f.stream(initial).result();
    expect(first.stopReason).toBe("stop");
    f.onSend(socket => socket.rejectSize());
    const secondContext: Context = {messages: [...initial.messages, first, user("second question")]};
    const second = await f.stream(secondContext).result();
    expect(second.stopReason).toBe("stop");
    expect(f.frames).toHaveLength(2); // One successful bootstrap, one rejected delta; no retries.
    expect(JSON.parse(f.frames[1]!).previous_response_id).toBe("ws_1");
    expect(f.http).toHaveLength(1);
    expect(f.http[0]!.previous_response_id).toBeUndefined();
    expect(inputTexts(f.http[0]!)).toEqual(["first question", "second question"]);
    const connections = f.sockets.length;
    const third = await f.stream({messages: [...secondContext.messages, second, user("third question")]}).result();
    expect(third.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(connections);
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(2);
    expect(f.http[1]!.previous_response_id).toBeUndefined();
    expect(inputTexts(f.http[1]!)).toEqual(["first question", "second question", "third question"]);
  } finally { f.close(); }
});

test("native compaction reset permits a fresh small websocket bootstrap after a size rejection", async () => {
  const f = fixture();
  try {
    f.onSend(socket => socket.rejectSize());
    expect((await f.stream(context("before compaction")).result()).stopReason).toBe("stop");
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(1);
    f.compact();
    f.onSend(socket => { for (const event of completedEvents("after_compaction")) socket.message(event); });
    expect((await f.stream(context("compact summary")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(1);
    const request = JSON.parse(f.frames[1]!) as Payload;
    expect(request.previous_response_id).toBeUndefined();
    expect(inputTexts(request)).toEqual(["compact summary"]);
  } finally { f.close(); }
});

// Synthetic protocol/unsupported-data/policy failures are not temporary outages.
test.each([1002, 1003, 1007, 1008, 1010])("handshake close(%d) stays disabled across cooldown and native compaction", async code => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  try {
    f.failHandshake(code);
    expect((await f.stream(context("before failure")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(1);
    expect(f.details()).toMatchObject({websocketDisabled: true,
      lastFallbackError: `Codex websocket transport error: websocket closed before open (${code})`});
    f.restoreHandshake();
    f.compact();
    now += 60_001;
    expect((await f.stream(context("compact summary")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(2);
  } finally { dateNow.mockRestore(); f.close(); }
});

// 1012 reproduces the overnight failure; the other closes cover adjacent ordinary
// connection loss/service restart conditions. An empty reasoning start is replay-safe.
test.each(["socket error", "connection expiry", "close 1000", "close 1001", "close 1006", "close 1011", "close 1012", "close 1013"] as const)("%s uses SSE during cooldown then restores full websocket history and delta chaining", async failure => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  const initial = context("first question");
  try {
    const first = await f.stream(initial).result();
    f.onSend(socket => {
      if (failure === "socket error") socket.fail("temporary connection failure");
      else {
        // The six-hour run expired after this empty reasoning placeholder.
        socket.message({type: "response.output_item.added", item: {
          type: "reasoning", id: "rs_empty", summary: [], content: [],
        }});
        if (failure === "connection expiry") socket.expire();
        else socket.remoteClose(Number(failure.split(" ")[1]));
      }
    });
    const failedContext: Context = {messages: [...initial.messages, first, user("second question")]};
    const recovering = f.stream(failedContext);
    const thinkingBlocks: string[] = [];
    for await (const event of recovering) {
      if (event.type === "thinking_start" || event.type === "thinking_end") thinkingBlocks.push(event.type);
    }
    const recovered = await recovering.result();
    expect(recovered.stopReason).toBe("stop");
    // Pet/log consumers must not retain an orphan thinking block from the
    // abandoned empty placeholder when this attempt is replaced by SSE.
    expect(thinkingBlocks).toEqual(failure === "socket error" ? [] : ["thinking_start", "thinking_end"]);
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(1);
    expect(inputTexts(f.http[0]!)).toEqual(["first question", "second question"]);
    expect(f.details()).toMatchObject({websocketDisabled: false, sizeBlockedUntilCompaction: false,
      retryWebsocketAt: now + 60_000, fallbackCount: 1});
    expect(f.details().lastFallbackError).toContain(failure === "socket error"
      ? "websocket error: temporary connection failure" : failure === "connection expiry"
        ? "connection limit reached (60 minutes)" : `websocket closed (${failure.split(" ")[1]})`);

    now += 59_999;
    const cooldownContext: Context = {messages: [...failedContext.messages, recovered, user("third question")]};
    const cooldown = await f.stream(cooldownContext).result();
    expect(cooldown.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(2);

    now += 2;
    f.onSend(socket => { for (const event of completedEvents(`ws_${f.frames.length}`)) socket.message(event); });
    const retryContext: Context = {messages: [...cooldownContext.messages, cooldown, user("fourth question")]};
    const retry = await f.stream(retryContext).result();
    expect(retry.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.http).toHaveLength(2);
    const bootstrap = JSON.parse(f.frames[2]!) as Payload;
    expect(bootstrap.previous_response_id).toBeUndefined();
    expect(inputTexts(bootstrap)).toEqual(["first question", "second question", "third question", "fourth question"]);
    expect(f.details().retryWebsocketAt).toBeUndefined();

    const next = await f.stream({messages: [...retryContext.messages, retry, user("fifth question")]}).result();
    expect(next.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.http).toHaveLength(2);
    const delta = JSON.parse(f.frames[3]!) as Payload;
    expect(delta.previous_response_id).toBe("ws_3");
    expect(inputTexts(delta)).toEqual(["fifth question"]);
  } finally { dateNow.mockRestore(); f.close(); }
});

test("1009 after a delivered tool call never replays that tool over SSE", async () => {
  const f = fixture();
  try {
    f.onSend(socket => {
      const item = {type: "function_call", id: "fc_once", call_id: "call_once", name: "move", arguments: ""};
      socket.message({type: "response.output_item.added", item});
      socket.message({type: "response.output_item.done", item: {...item, arguments: "{}"}});
      socket.rejectSize();
    });
    const stream = f.stream(context("use a tool"));
    let delivered = 0;
    for await (const event of stream) if (event.type === "toolcall_end") delivered++;
    expect((await stream.result()).stopReason).toBe("error");
    expect(delivered).toBe(1);
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(0);
    // Refusing to replay this request must still retain the size decision for
    // later turns; only native history compaction makes another frame worthwhile.
    expect(f.details()).toMatchObject({sizeBlockedUntilCompaction: true, websocketDisabled: false});
    expect((await f.stream(context("another turn before compaction")).result()).stopReason).toBe("stop");
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(1);
    f.compact();
    f.onSend(socket => { for (const event of completedEvents("after_partial_size")) socket.message(event); });
    expect((await f.stream(context("compact summary")).result()).stopReason).toBe("stop");
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(1);
    expect(JSON.parse(f.frames[1]!).previous_response_id).toBeUndefined();
  } finally { f.close(); }
});

test.each(["socket error", "connection expiry"] as const)("%s after a delivered tool call never replays that tool over SSE", async failure => {
  const f = fixture();
  try {
    f.onSend(socket => {
      const item = {type: "function_call", id: "fc_once", call_id: "call_once", name: "move", arguments: ""};
      socket.message({type: "response.output_item.added", item});
      socket.message({type: "response.output_item.done", item: {...item, arguments: "{}"}});
      if (failure === "socket error") socket.fail("temporary connection failure");
      else socket.expire();
    });
    const stream = f.stream(context("use a tool"));
    let delivered = 0;
    for await (const event of stream) if (event.type === "toolcall_end") delivered++;
    expect((await stream.result()).stopReason).toBe("error");
    expect(delivered).toBe(1);
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(0);
  } finally { f.close(); }
});

test("caller cancellation during a rejected websocket attempt does not start SSE fallback", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.onSend(socket => { socket.rejectSize(); controller.abort(); });
    const result = await f.stream(context("cancel me"), {signal: controller.signal}).result();
    expect(result.stopReason).toBe("aborted");
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(0);
  } finally { f.close(); }
});

test("cancelling a partial websocket response permits a fresh websocket in the same session", async () => {
  const f = fixture();
  const controller = new AbortController();
  const initial = context("play until the budget ends");
  try {
    // Deliver real response content, but no terminal event, before the budget expires.
    f.onSend(socket => {
      for (const event of completedEvents("interrupted").slice(0, 4)) socket.message(event);
    });
    const stream = f.stream(initial, {signal: controller.signal});
    let partialTextEvents = 0;
    for await (const event of stream) {
      if (event.type === "text_delta") {
        partialTextEvents++;
        controller.abort(new Error("run budget ended"));
      }
    }
    const interrupted = await stream.result();
    expect(partialTextEvents).toBe(1);
    expect(interrupted.stopReason).toBe("aborted");
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(0);
    expect(f.sockets[0]!.readyState).toBe(WebSocket.CLOSED);

    f.onSend(socket => { for (const event of completedEvents("resumed")) socket.message(event); });
    const resumed = await f.stream({messages: [...initial.messages, interrupted, user("resume playing")]}, {
      signal: new AbortController().signal,
    }).result();
    expect(resumed.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(2);
    expect(f.http).toHaveLength(0);
    const request = JSON.parse(f.frames[1]!) as Payload;
    expect(request.previous_response_id).toBeUndefined();
    expect(inputTexts(request)).toEqual(["play until the budget ends", "resume playing"]);
  } finally { f.close(); }
});

test("handshake timeout uses SSE during cooldown and retries websocket after 60 seconds", async () => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  const originalSetTimeout = globalThis.setTimeout;
  // Only accelerate the provider's 10-second handshake watchdog; leave other timers alone.
  const acceleratedTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
    const [callback, delay, ...rest] = args;
    return originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...rest);
  }, originalSetTimeout);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(acceleratedTimeout);
  try {
    f.stallNextHandshake();
    expect((await f.stream(context("initial handshake times out")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(1);

    now += 59_999;
    expect((await f.stream(context("still cooling down")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(2);

    now += 2;
    expect((await f.stream(context("retry after cooldown")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(2);
    const request = JSON.parse(f.frames[0]!) as Payload;
    expect(request.previous_response_id).toBeUndefined();
    expect(inputTexts(request)).toEqual(["retry after cooldown"]);
  } finally {
    timeout.mockRestore();
    dateNow.mockRestore();
    f.close();
  }
});

// Fault injection at the earlier handshake boundary must have the same future-
// request policy as a close after the socket opened; no response was committed.
test.each([1006, 1012, 1013])("transient handshake close(%d) falls back once and recovers after cooldown", async code => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  try {
    f.failHandshake(code);
    const initial = context("handshake request");
    const first = await f.stream(initial).result();
    expect(first.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(1);
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(1);
    expect(f.details()).toMatchObject({websocketDisabled: false, retryWebsocketAt: now + 60_000});
    f.restoreHandshake();
    now += 59_999;
    const secondContext: Context = {messages: [...initial.messages, first, user("cooldown")]};
    const second = await f.stream(secondContext).result();
    expect(f.sockets).toHaveLength(1);
    expect(f.http).toHaveLength(2);
    now += 2;
    expect((await f.stream({messages: [...secondContext.messages, second, user("recover")]}).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.http).toHaveLength(2);
    const bootstrap = JSON.parse(f.frames[0]!) as Payload;
    expect(bootstrap.previous_response_id).toBeUndefined();
    expect(inputTexts(bootstrap)).toEqual(["handshake request", "cooldown", "recover"]);
  } finally { dateNow.mockRestore(); f.close(); }
});

// Follow OMP's native commit boundary: text/thinking may be replaced by SSE;
// a completed tool call is already executable and must never be replayed.
for (const output of ["text", "thinking", "tool"] as const) {
  test.each(["close 1012", "connection expiry"] as const)(`${output} delivered: %s follows the native replay boundary and later restores websocket`, async failure => {
    const f = fixture();
    let now = Date.now();
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    try {
      f.onSend(socket => {
        if (output === "text") {
          for (const event of completedEvents("partial").slice(0, 4)) socket.message(event);
        } else if (output === "thinking") {
          socket.message({type: "response.output_item.added", item: {type: "reasoning", id: "rs_partial", summary: [], content: []}});
          socket.message({type: "response.reasoning_summary_text.delta", delta: "partial thought"});
        } else {
          const item = {type: "function_call", id: "fc_once", call_id: "call_once", name: "move", arguments: ""};
          socket.message({type: "response.output_item.added", item});
          socket.message({type: "response.output_item.done", item: {...item, arguments: "{}"}});
        }
        if (failure === "close 1012") socket.remoteClose(1012);
        else socket.expire();
      });
      const initial = context("perform a step");
      const stream = f.stream(initial);
      let delivered = 0;
      const committedEvent = output === "tool" ? "toolcall_end" : output === "thinking" ? "thinking_delta" : "text_delta";
      for await (const event of stream) if (event.type === committedEvent) delivered++;
      const partial = await stream.result();
      const replayed = output !== "tool";
      expect(partial.stopReason).toBe(replayed ? "stop" : "error");
      // SSE emits another text delta after the abandoned partial text; this is
      // the native stream contract, not evidence of executing a tool twice.
      expect(delivered).toBe(output === "text" ? 2 : 1);
      expect(f.frames).toHaveLength(1);
      expect(f.http).toHaveLength(replayed ? 1 : 0);
      expect(f.details()).toMatchObject({websocketDisabled: false, retryWebsocketAt: now + 60_000});

      f.onSend(socket => { for (const event of completedEvents(`ws_${f.frames.length}`)) socket.message(event); });
      const cooldownContext: Context = {messages: [...initial.messages, partial, user("continue after interrupted response")]};
      const cooldown = await f.stream(cooldownContext).result();
      expect(cooldown.stopReason).toBe("stop");
      expect(f.frames).toHaveLength(1);
      expect(f.http).toHaveLength(replayed ? 2 : 1);
      now += 60_001;
      const recoveryContext: Context = {messages: [...cooldownContext.messages, cooldown, user("retry websocket")]};
      const recovered = await f.stream(recoveryContext).result();
      expect(recovered.stopReason).toBe("stop");
      expect(f.sockets).toHaveLength(2);
      expect(f.http).toHaveLength(replayed ? 2 : 1);
      const bootstrap = JSON.parse(f.frames[1]!) as Payload;
      expect(bootstrap.previous_response_id).toBeUndefined();
      expect(inputTexts(bootstrap)).toEqual(["perform a step", "continue after interrupted response", "retry websocket"]);
      const next = await f.stream({messages: [...recoveryContext.messages, recovered, user("next delta")]}).result();
      expect(next.stopReason).toBe("stop");
      const delta = JSON.parse(f.frames[2]!) as Payload;
      expect(delta.previous_response_id).toBe("ws_2");
      expect(inputTexts(delta)).toEqual(["next delta"]);
    } finally { dateNow.mockRestore(); f.close(); }
  });
}

test("cancellation during handshake does not poison the next request or launch SSE", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.stallNextHandshake();
    const stream = f.stream(context("cancel before socket opens"), {signal: controller.signal});
    // Wait for the connection to be installed, without depending on wall-clock sleeps.
    while (f.sockets.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(new Error("human took control"));
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(f.frames).toHaveLength(0);
    expect(f.http).toHaveLength(0);
    expect(f.details()).toMatchObject({websocketDisabled: false});
    expect(f.details().retryWebsocketAt).toBeUndefined();
    expect((await f.stream(context("new turn after handoff")).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(2);
    expect(f.frames).toHaveLength(1);
    expect(f.http).toHaveLength(0);
  } finally { f.close(); }
});

// Synthetic no-output failures exercise the bounded in-request retry path,
// separately from the real-run empty-reasoning path that falls back immediately.
test.each(["send throws", "malformed frame", "first event timeout"] as const)("%s exhausts bounded retries, then cools down and recovers", async failure => {
  const f = fixture();
  let now = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  const waits: number[] = [];
  // Virtualize retry backoff only, leaving the actual stream watchdog observable.
  const wait = spyOn(scheduler, "wait").mockImplementation(async (delay, options) => {
    options?.signal?.throwIfAborted();
    waits.push(delay);
  });
  try {
    f.onSend(socket => {
      if (failure === "send throws") throw new Error("injected send failure");
      if (failure === "malformed frame") socket.raw("{invalid JSON");
      // Timeout case sends nothing, so the first-event watchdog expires.
    });
    const initial = context("request with no output yet");
    const first = await f.stream(initial, {streamFirstEventTimeoutMs: 1}).result();
    expect(first.stopReason).toBe("stop");
    expect(f.http).toHaveLength(1);
    expect(f.frames.length).toBeGreaterThan(0);
    expect(f.frames.length).toBeLessThanOrEqual(6); // Current provider budget: initial + five retries.
    expect(waits.length).toBeLessThanOrEqual(5);
    expect(f.details()).toMatchObject({websocketDisabled: false, retryWebsocketAt: now + 60_000});
    const connections = f.sockets.length;
    const frameCount = f.frames.length;
    const secondContext: Context = {messages: [...initial.messages, first, user("cooldown request")]};
    const second = await f.stream(secondContext).result();
    expect(second.stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(connections);
    expect(f.http).toHaveLength(2);
    now += 60_001;
    f.onSend(socket => { for (const event of completedEvents(`ws_${f.frames.length}`)) socket.message(event); });
    expect((await f.stream({messages: [...secondContext.messages, second, user("recovery request")]}).result()).stopReason).toBe("stop");
    expect(f.sockets).toHaveLength(connections + 1);
    expect(f.http).toHaveLength(2);
    const bootstrap = JSON.parse(f.frames[frameCount]!) as Payload;
    expect(bootstrap.previous_response_id).toBeUndefined();
    expect(inputTexts(bootstrap)).toEqual(["request with no output yet", "cooldown request", "recovery request"]);
  } finally { wait.mockRestore(); dateNow.mockRestore(); f.close(); }
});
