import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { ModelTrace, installCompactionHttpTrace } from "../../harness/omp/trace.ts";
import type { BenchmarkContext } from "../types.ts";
import { syntheticKey, until } from "./evidence.ts";

export const threshold = 256_000;
const contextWindow = 512_000;
type JournalMessage = Parameters<SessionManager["appendMessage"]>[0];

/** OMP preparation, native V2 serialization, parsing, validation, commit and tail replay all remain real. */
export async function nativeCompaction(ctx: BenchmarkContext, initialEpoch: string) {
  ctx.signal?.throwIfAborted();
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const requests: Array<{ signal?: AbortSignal | null; body: Record<string, any>; controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }> = [];
  const encoder = new TextEncoder();
  const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://chatgpt.com/backend-api/codex/responses") throw new Error(`Offline benchmark rejected unexpected URL: ${url}`);
    const raw = init?.body;
    const json = typeof raw === "string" ? raw : raw instanceof Uint8Array
      ? new TextDecoder().decode(Bun.zstdDecompressSync(raw)) : "";
    const request = { signal: init?.signal, body: JSON.parse(json), controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>, closed: false };
    const body = new ReadableStream<Uint8Array>({ start(controller) { request.controller = controller; }, cancel() { request.closed = true; } });
    requests.push(request);
    await Bun.sleep(5); // Response headers precede the controlled summary body.
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect }) as typeof globalThis.fetch;
  globalThis.WebSocket = class { constructor() { throw new Error("Offline compaction must use isolated SSE"); } } as unknown as typeof WebSocket;
  const model = { ...getBundledModel("openai-codex", "gpt-6.1-sol"), contextWindow,
    baseUrl: "https://chatgpt.com/backend-api", useResponsesLite: true, remoteCompaction: { v2StreamingEnabled: true } };
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime("openai-codex", syntheticKey);
  const settings = Settings.isolated({
    "memory.backend": "off", "compaction.enabled": true, "compaction.asyncEnabled": true,
    "compaction.methodOrder": ["remote"], "compaction.thresholdTokens": threshold,
    "compaction.keepRecentTokens": 1, "compaction.autoContinue": false,
    "compaction.experimentalContextManagement": false,
  });
  const modelRegistry = new ModelRegistry(auth, undefined, { settings });
  const manager = SessionManager.inMemory();
  const agent = new Agent({ initialState: { model, systemPrompt: ["Offline benchmark conversation"], tools: [], messages: [] } });
  const append = (message: JournalMessage) => { manager.appendMessage(message); agent.replaceMessages(manager.buildSessionContext().messages); };
  const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
    api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 10_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  append(user("conversation ".repeat(8_000)));
  append(assistant("response ".repeat(8_000)));
  append(user("next turn ".repeat(8_000)));
  append(assistant("snapshot leaf"));
  const initialLeafId = manager.getBranch().at(-1)!.id;
  const tail: JournalMessage[] = [user("post-snapshot request"), {
    ...assistant(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "call_tail", name: "observe", arguments: {} }],
  }, { role: "toolResult", toolCallId: "call_tail", toolName: "observe", content: [{ type: "text", text: "new observation" }],
    isError: false, timestamp: Date.now() }, user("continue after observing")];
  let epoch: string | undefined = initialEpoch;
  let emit: Parameters<AgentSession["subscribe"]>[0] = () => {};
  const trace = new ModelTrace(ctx.log, () => ({ epoch }));
  const detach = trace.attach({ agent, subscribe(listener: typeof emit) { emit = listener; return () => {}; } } as unknown as AgentSession);
  const detachHttp = installCompactionHttpTrace(ctx.log, trace.compactionParent);
  const providerSessionState: SessionMaintenanceHost["providerSessionState"] = new Map();
  const events: Parameters<SessionMaintenanceHost["emitSessionEvent"]>[0][] = [];
  const host: SessionMaintenanceHost = {
    agent, sessionManager: manager, settings, modelRegistry, extensionRunner: undefined,
    sideStreamFn: async () => { throw new Error("Native V2 compaction must handle the offline summary"); },
    providerSessionState, preferWebsockets: () => true, model: () => model,
    thinkingLevel: () => undefined, isDisposed: () => false, isStreaming: () => false,
    isGeneratingHandoff: () => false, promptGeneration: () => 0, sessionId: () => manager.getSessionId(),
    messages: () => agent.state.messages, baseSystemPrompt: () => agent.state.systemPrompt,
    goalModeState: () => undefined, planReferencePath: () => "", nonMessageTokenSource: () => ({}),
    hasExperimentalContextRolloverTools: () => false, takeExperimentalContextRolloverRequest: () => false,
    queueExperimentalContextNotesReminder: () => {}, memoryBackendSession: () => undefined,
    emitSessionEvent: async event => { events.push(event); emit(event); },
    emitNotice: () => {}, scheduleAgentContinue: () => {}, scheduleCompactionContinuation: () => false,
    persistTurnMessagesForMidRunCompaction: async () => false, findLastAssistantMessage: () => undefined,
    disconnectFromAgent: () => {}, reconnectToAgent: () => {}, drainStrandedQueuedMessages: () => {},
    buildDisplaySessionContext: () => manager.buildSessionContext(), convertToLlmForSideRequest: convertToLlm,
    buildLiveProviderContext: async (summarized, retained) => ({ messages: convertToLlm([...summarized, ...retained]) }),
    obfuscateTextForProvider: text => text, obfuscatePreparationForProvider: preparation => preparation,
    closeCodexProviderSessionsForHistoryRewrite: () => {}, resetCodexProviderAfterCompaction: () => {},
    resetPlanReference: () => {}, syncTodoPhasesFromBranch: () => {}, resetAdvisorRuntimes: () => {},
    rebaseAdvisorPrefix: () => {}, rebaseAfterCompaction: () => {}, recordAnchoredHistoryRewrite: () => {},
    getContextBreakdown: () => undefined, getContextUsage: () => undefined,
    shake: async mode => ({ mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 }), dropImages: async () => ({ removed: 0 }),
    generateHandoffDocument: async () => undefined, removeAssistantMessageFromActiveContext: () => {},
    dropPersistedAssistantTurn: async () => undefined, retainTerminalFailure: () => {},
    runRecoveryCompactionWithRollback: async () => ({ continuationScheduled: false }),
    parseRetryAfterMsFromError: () => undefined, setModelTemporary: async () => {},
    abort: async () => {}, abortHandoff: () => {},
  };
  const maintenance = new SessionMaintenance(host);
  const abort = () => { maintenance.abortCompaction(ctx.signal?.reason); maintenance.cancelSpeculation(); };
  ctx.signal?.addEventListener("abort", abort, { once: true });
  let background: Promise<void> | undefined;
  let blocking: ReturnType<SessionMaintenance["runAutoCompaction"]> | undefined;
  const finishResponse = (index = 0) => {
    const request = requests[index];
    if (!request || request.closed) return;
    const events = [
      { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "offline-native-summary" } },
      { type: "response.completed", response: { id: `summary-${index}`, usage: {
        input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80 },
      } } },
    ];
    request.controller.enqueue(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    request.controller.close(); request.closed = true;
  };
  return {
    maintenance, manager, agent, requests, events, initialLeafId, tail,
    changeEpoch(value: string | undefined) { epoch = value; },
    appendTail() { for (const message of tail) append(message); },
    async start() {
      ctx.signal?.throwIfAborted();
      maintenance.maybeStartSpeculativeCompaction(threshold - 8_192, contextWindow);
      background = maintenance.speculationCompletion;
      await until(() => requests.length > 0, 5_000, ctx.signal);
      await Bun.sleep(10);
      ctx.signal?.throwIfAborted();
    },
    async block() {
      ctx.signal?.throwIfAborted();
      blocking = maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: threshold + 32_768 });
      await until(() => events.some(event => event.type === "auto_compaction_start"), 5_000, ctx.signal);
      return { completion: blocking };
    },
    finishResponse,
    compactions: () => manager.getEntries().filter(entry => entry.type === "compaction"),
    async close() {
      ctx.signal?.removeEventListener("abort", abort);
      maintenance.abortCompaction(); maintenance.cancelSpeculation();
      requests.forEach((_request, index) => finishResponse(index));
      await Promise.allSettled([background, blocking]);
      detach(); detachHttp();
      for (const state of providerSessionState.values()) state.close();
      auth.close(); await manager.close();
      globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
    },
  };
}
