import { expect, spyOn, test } from "bun:test";
import { compact, DEFAULT_COMPACTION_SETTINGS, type CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";

const model = buildModel({
  id: "gpt-6.1-sol", name: "Offline native compaction", api: "openai-codex-responses",
  provider: "openai-codex", baseUrl: "http://127.0.0.1:9", reasoning: true,
  input: ["text"], contextWindow: 272000, maxTokens: 4096, useResponsesLite: true,
  remoteCompaction: {v2StreamingEnabled: true},
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
});
// Synthetic credential; all traffic is intercepted before reaching a network.
const apiKey = `aaa.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": {chatgpt_account_id: "rsa-offline-affinity-test"},
})).toString("base64url")}.bbb`;

test("native V2 summaries share parent header affinity while preserving isolated SSE sessions and Lite bodies", async () => {
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
  const installId = spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000002");
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error("Native speculation must remain on SSE"); } } as unknown as typeof WebSocket;
  const providerSessionState = new Map<string, ProviderSessionState>();
  const requests: Array<{headers: Headers; body: Record<string, any>}> = [];
  const fetch: FetchImpl = async (_input, init) => {
    const raw = init?.body;
    const json = typeof raw === "string" ? raw : raw instanceof Uint8Array
      ? new TextDecoder().decode(Bun.zstdDecompressSync(raw)) : "";
    requests.push({headers: new Headers(init?.headers), body: JSON.parse(json)});
    const events = [
      {type: "response.output_item.done", item: {type: "compaction", encrypted_content: "offline-native-summary"}},
      {type: "response.completed", response: {id: `summary-${requests.length}`, usage: {
        input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: {cached_tokens: 80},
      }}},
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      {headers: {"content-type": "text/event-stream"}});
  };
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "retained", messagesToSummarize: [{role: "user", content: "Preserve the current game progress.", timestamp: 1}],
    turnPrefixMessages: [], recentMessages: [], isSplitTurn: false, tokensBefore: 100,
    fileOps: {read: new Set(), written: new Set(), edited: new Set()}, settings: DEFAULT_COMPACTION_SETTINGS,
  };
  const parentSessionId = "rsa-parent-session";
  const promptCacheKey = "separate-body-cache-key";
  try {
    for (const sessionId of ["rsa-parent-session:spec:first", "rsa-parent-session:spec:second"]) {
      const result = await compact(preparation, model, apiKey, undefined, undefined, {
        sessionId, parentSessionId, promptCacheKey, preferWebsockets: false, providerSessionState, fetch,
        thinkingLevel: ThinkingLevel.Low, remoteSystemPrompt: ["Keep useful game state."], tools: [],
        codexCompaction: {operationId: `operation-${sessionId}`, trigger: "auto", reason: "context_limit", phase: "standalone_turn", strategy: "memento"},
      });
      expect(result.preserveData?.openaiRemoteCompaction).toMatchObject({version: "v2", usedTokens: 100,
        usage: {cachedInputTokens: 80}});
    }
    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      const specSessionId = index === 0 ? "rsa-parent-session:spec:first" : "rsa-parent-session:spec:second";
      for (const header of ["session_id", "conversation_id", "session-id"]) {
        expect(request.headers.get(header)).toBe(parentSessionId);
        expect(request.headers.get(header)).not.toBe(promptCacheKey);
      }
      expect(request.headers.get("x-client-request-id")).toBe(specSessionId);
      expect(request.body.client_metadata.session_id).toBe(specSessionId);
      expect(JSON.parse(request.body.client_metadata["x-codex-turn-metadata"]).session_id).toBe(specSessionId);
      expect(request.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
      expect(request.body.prompt_cache_key).toBe(promptCacheKey);
      expect(request.body.instructions).toBeUndefined();
      expect(request.body.tools).toBeUndefined();
      expect(request.body.input[0]).toEqual({type: "additional_tools", role: "developer", tools: []});
      expect(request.body.input[1]).toMatchObject({role: "developer", content: [{type: "input_text", text: "Keep useful game state."}]});
      expect(request.body.input.at(-1)).toEqual({type: "compaction_trigger"});
      expect(request.body.reasoning).toMatchObject({effort: "low", context: "all_turns"});
      expect(request.body.previous_response_id).toBeUndefined();
    }
    expect(requests[0]!.body.client_metadata.thread_id).not.toBe(requests[1]!.body.client_metadata.thread_id);
    const {client_metadata: firstIdentity, ...firstBody} = requests[0]!.body;
    const {client_metadata: secondIdentity, ...secondBody} = requests[1]!.body;
    expect(firstIdentity.session_id).not.toBe(secondIdentity.session_id);
    expect(firstBody).toEqual(secondBody);
    expect(network).not.toHaveBeenCalled();
  } finally {
    for (const provider of providerSessionState.values()) provider.close();
    globalThis.WebSocket = originalWebSocket;
    installId.mockRestore();
    network.mockRestore();
  }
});
