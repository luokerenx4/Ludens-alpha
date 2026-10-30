import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getOpenAICodexTransportDetails } from "@oh-my-pi/pi-ai/providers/openai-codex-state";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { syntheticKey } from "./evidence.ts";

export const fixtureModel = buildModel({
  id: "gpt-6.1-sol", name: "Offline Codex benchmark", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "http://127.0.0.1:9", reasoning: true, preferWebsockets: true, input: ["text"],
  contextWindow: 256_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
export const userMessage = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
export type Payload = Record<string, any>;
export const inputTexts = (body: Payload): string[] => (body.input as Array<{ content?: Array<{ type: string; text?: string }> }>)
  .flatMap(item => item.content ?? []).filter(part => part.type === "input_text").map(part => part.text!);

function completedEvents(id: string) {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] };
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: "OK" },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, status: "completed", usage: {
      input_tokens: 100, output_tokens: 1, total_tokens: 101, input_tokens_details: { cached_tokens: 80 },
    } } },
  ];
}

export interface SimulatedSocket {
  message(value: object): void;
  expire(): void;
  closeFromServer(code: number): void;
}

/** No networking occurs: all WebSocket and fetch paths are replaced before invoking the real provider. */
export function codexTransport() {
  const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
  const previousEnv = Bun.env.PI_CODEX_WEBSOCKET;
  Bun.env.PI_CODEX_WEBSOCKET = "1";
  const states = new Map<string, ProviderSessionState>();
  const frames: Payload[] = [], frameBytes: number[] = [], http: Payload[] = [];
  const sockets: FakeSocket[] = [];
  let onSend = (socket: SimulatedSocket) => {
    for (const event of completedEvents(`ws_${frames.length}`)) socket.message(event);
  };
  class FakeSocket implements SimulatedSocket {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING; bufferedAmount = 0; binaryType = "nodebuffer";
    onopen?: (event: object) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: (event: object) => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.onopen?.({}); });
    }
    send(data: string) { frames.push(JSON.parse(data)); frameBytes.push(Buffer.byteLength(data)); onSend(this); }
    message(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    expire() { this.message({ type: "error", code: "websocket_connection_limit_reached",
      message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue." }); }
    closeFromServer(code: number) { this.readyState = FakeSocket.CLOSED; this.onclose?.({ code, reason: "" }); }
    close() { this.readyState = FakeSocket.CLOSED; }
  }
  const fetch: FetchImpl = async (_input, init) => {
    const body = init?.body;
    const json = typeof body === "string" ? body : body instanceof Uint8Array
      ? new TextDecoder().decode(Bun.zstdDecompressSync(body)) : "";
    http.push(JSON.parse(json));
    return new Response(completedEvents(`sse_${http.length}`).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  };
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(fetch, { preconnect: originalFetch.preconnect }) as typeof globalThis.fetch;
  const options = { apiKey: syntheticKey, fetch, providerSessionState: states, sessionId: crypto.randomUUID(), preferWebsockets: true };
  return {
    options, frames, frameBytes, http, sockets,
    stream: streamOpenAICodexResponses,
    details: () => getOpenAICodexTransportDetails(fixtureModel, options),
    onSend(callback: typeof onSend) { onSend = callback; },
    complete(socket: SimulatedSocket) { for (const event of completedEvents(`ws_${frames.length}`)) socket.message(event); },
    close() {
      for (const state of states.values()) state.close(); states.clear();
      globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch;
      if (previousEnv === undefined) delete Bun.env.PI_CODEX_WEBSOCKET; else Bun.env.PI_CODEX_WEBSOCKET = previousEnv;
    },
  };
}
