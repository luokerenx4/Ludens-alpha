import { expect, spyOn, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

const threshold = 256_000;
const contextWindow = 512_000;
const model = {...getBundledModel("openai-codex", "gpt-6.1-sol"), contextWindow};
const user = (text: string): UserMessage => ({role: "user", content: [{type: "text", text}], timestamp: Date.now()});
const assistant = (text: string): AssistantMessage => ({
  role: "assistant", content: [{type: "text", text}], api: model.api, provider: model.provider, model: model.id,
  stopReason: "stop", timestamp: Date.now(), usage: {input: 10_000, output: 100, cacheRead: 0,
    cacheWrite: 0, totalTokens: 10_100, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type CompactCall = {preparation: Parameters<typeof compaction.compact>[0]; signal: AbortSignal;
  options: Parameters<typeof compaction.compact>[5]};
type JournalMessage = Parameters<SessionManager["appendMessage"]>[0];

function nativeResult(preparation: CompactCall["preparation"], summary: string): compaction.CompactionResult {
  return {summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
    details: {}, preserveData: {openaiRemoteCompaction: {version: "v2", provider: model.provider,
      replacementHistory: [{type: "compaction_summary", summary}], usedTokens: 1_000}}};
}

/** The native summarizer is deferred; OMP preparation, validation, commit and tail replay stay real. */
async function fixture(keepRecentTokens = 1) {
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in offline compaction test"));
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime("openai-codex", "offline-compaction-only");
  const settings = Settings.isolated({
    "memory.backend": "off", "compaction.enabled": true, "compaction.asyncEnabled": true,
    "compaction.methodOrder": ["remote"], "compaction.thresholdTokens": threshold,
    "compaction.keepRecentTokens": keepRecentTokens, "compaction.autoContinue": false,
    "compaction.experimentalContextManagement": false,
  });
  const modelRegistry = new ModelRegistry(auth, undefined, {settings});
  const manager = SessionManager.inMemory();
  const agent = new Agent({initialState: {model, systemPrompt: ["Offline compaction regression"], tools: [], messages: []}});
  const append = (message: JournalMessage) => {
    manager.appendMessage(message);
    agent.replaceMessages(manager.buildSessionContext().messages);
  };
  append(user("conversation ".repeat(8_000)));
  append(assistant("response ".repeat(8_000)));
  append(user("next turn ".repeat(8_000)));
  append(assistant("snapshot leaf"));
  const initialLeafId = manager.getBranch().at(-1)!.id;
  const events: Parameters<SessionMaintenanceHost["emitSessionEvent"]>[0][] = [];
  const autoStarted = Promise.withResolvers<void>();
  const host: SessionMaintenanceHost = {
    agent, sessionManager: manager, settings, modelRegistry, extensionRunner: undefined,
    sideStreamFn: async () => { throw new Error("The offline compact boundary must handle summarization"); },
    providerSessionState: new Map(), preferWebsockets: () => true, model: () => model,
    thinkingLevel: () => undefined, isDisposed: () => false, isStreaming: () => false,
    isGeneratingHandoff: () => false, promptGeneration: () => 0, sessionId: () => manager.getSessionId(),
    messages: () => agent.state.messages, baseSystemPrompt: () => agent.state.systemPrompt,
    goalModeState: () => undefined, planReferencePath: () => "", nonMessageTokenSource: () => ({}),
    hasExperimentalContextRolloverTools: () => false, takeExperimentalContextRolloverRequest: () => false,
    queueExperimentalContextNotesReminder: () => {}, memoryBackendSession: () => undefined,
    emitSessionEvent: async event => { events.push(event); if (event.type === "auto_compaction_start") autoStarted.resolve(); },
    emitNotice: () => {}, scheduleAgentContinue: () => {}, scheduleCompactionContinuation: () => false,
    persistTurnMessagesForMidRunCompaction: async () => false, findLastAssistantMessage: () => undefined,
    disconnectFromAgent: () => {}, reconnectToAgent: () => {}, drainStrandedQueuedMessages: () => {},
    buildDisplaySessionContext: () => manager.buildSessionContext(), convertToLlmForSideRequest: convertToLlm,
    buildLiveProviderContext: async (summarized, retained) => ({messages: convertToLlm([...summarized, ...retained])}),
    obfuscateTextForProvider: text => text, obfuscatePreparationForProvider: preparation => preparation,
    closeCodexProviderSessionsForHistoryRewrite: () => {}, resetCodexProviderAfterCompaction: () => {},
    resetPlanReference: () => {}, syncTodoPhasesFromBranch: () => {}, resetAdvisorRuntimes: () => {},
    rebaseAdvisorPrefix: () => {}, rebaseAfterCompaction: () => {}, recordAnchoredHistoryRewrite: () => {},
    getContextBreakdown: () => undefined, getContextUsage: () => undefined,
    shake: async mode => ({mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0}), dropImages: async () => ({removed: 0}),
    generateHandoffDocument: async () => undefined, removeAssistantMessageFromActiveContext: () => {},
    dropPersistedAssistantTurn: async () => undefined, retainTerminalFailure: () => {},
    runRecoveryCompactionWithRollback: async () => ({continuationScheduled: false}),
    parseRetryAfterMsFromError: () => undefined, setModelTemporary: async () => {},
    abort: async () => {}, abortHandoff: () => {},
  };
  const maintenance = new SessionMaintenance(host);
  const calls: CompactCall[] = [];
  const started = Promise.withResolvers<CompactCall>();
  const first = Promise.withResolvers<compaction.CompactionResult>();
  const compact = spyOn(compaction, "compact").mockImplementation(async (preparation, _model, _key, _instructions, signal, options) => {
    if (!signal) throw new Error("Expected OMP's compaction cancellation signal");
    const call = {preparation, signal, options};
    calls.push(call);
    if (calls.length === 1) { started.resolve(call); return first.promise; }
    return nativeResult(preparation, "fresh native summary");
  });
  let background: Promise<void> | undefined;
  let blocking: ReturnType<SessionMaintenance["runAutoCompaction"]> | undefined;
  return {
    maintenance, manager, agent, append, initialLeafId, events, calls, first,
    async start(contextTokens = threshold - 8_192) {
      maintenance.maybeStartSpeculativeCompaction(contextTokens, contextWindow);
      background = maintenance.speculationCompletion;
      return started.promise;
    },
    async block() {
      blocking = maintenance.runAutoCompaction("threshold", false, {triggerContextTokens: threshold + 32_768});
      await autoStarted.promise;
      // Allow all immediate maintenance continuations to run before inspecting its state.
      await tick();
      return {completion: blocking};
    },
    compactions: () => manager.getEntries().filter(entry => entry.type === "compaction"),
    async close() {
      maintenance.abortCompaction();
      maintenance.cancelSpeculation();
      if (calls[0]) first.resolve(nativeResult(calls[0].preparation, "late cleanup result"));
      await Promise.allSettled([background, blocking]);
      compact.mockRestore();
      network.mockRestore();
      auth.close();
      await manager.close();
    },
  };
}

test("threshold waits for running native speculation and replays history appended after its snapshot", async () => {
  const f = await fixture();
  try {
    const source = await f.start();
    expect(source.options?.sessionId?.startsWith(`${f.manager.getSessionId()}:spec:`)).toBe(true);
    expect(source.options?.sessionId).not.toBe(f.manager.getSessionId());
    expect(source.options?.parentSessionId).toBe(f.manager.getSessionId());
    expect(source.options?.preferWebsockets).toBe(false);
    const tail: JournalMessage[] = [user("post-snapshot request"), {
      ...assistant(""), stopReason: "toolUse", content: [{type: "toolCall", id: "call_tail", name: "observe", arguments: {}}],
    }, {role: "toolResult", toolCallId: "call_tail", toolName: "observe", content: [{type: "text", text: "new observation"}],
      isError: false, timestamp: Date.now()}, user("continue after observing")];
    for (const message of tail) f.append(message);
    const {completion} = await f.block();
    expect(f.maintenance.isCompacting).toBe(true);
    expect(f.maintenance.speculationState).toBe("running");
    expect(source.signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.compactions()).toHaveLength(0);
    f.first.resolve(nativeResult(source.preparation, "reused native summary"));
    await completion;

    expect(f.calls).toHaveLength(1);
    expect(source.signal.aborted).toBe(false);
    expect(f.maintenance.speculationState).toBe("idle");
    expect(f.maintenance.isCompacting).toBe(false);
    expect(f.compactions()).toHaveLength(1);
    expect(f.compactions()[0]).toMatchObject({summary: "reused native summary", method: "remote",
      providerReplayThroughEntryId: f.initialLeafId, tokensBefore: threshold + 32_768});
    expect(f.agent.state.messages[0]?.role).toBe("compactionSummary");
    expect(f.agent.state.messages.slice(1)).toEqual(tail);
    const next = compaction.prepareCompaction(f.manager.getBranch(),
      {...compaction.DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1}, model, f.agent.tokenizer)!;
    expect([...next.messagesToSummarize, ...next.turnPrefixMessages, ...next.recentMessages]).toEqual(tail);
    expect(f.events.filter(event => event.type === "auto_compaction_end")).toEqual([
      expect.objectContaining({aborted: false, action: "remote"}),
    ]);
  } finally { await f.close(); }
});

test("completed native summary survives growth beyond keepRecentTokens and preserves the new tail", async () => {
  const f = await fixture(20_000);
  try {
    const source = await f.start(224_242);
    const tail = user("new observations after the summary snapshot ".repeat(3_000));
    f.append(tail);
    f.first.resolve(nativeResult(source.preparation, "ready before threshold"));
    await f.maintenance.speculationCompletion;
    expect(f.maintenance.speculationState).toBe("armed");

    // The real run grew by ~29k while summarizing. That alone must not throw
    // away a ready result and pay for another ~90-second request near 256k.
    f.maintenance.maybeStartSpeculativeCompaction(253_573, contextWindow);
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(f.maintenance.speculationState).toBe("armed");
    expect(f.compactions()).toHaveLength(0);
    expect(f.maintenance.deferThresholdCompactionToSpeculation(threshold, contextWindow)).toBe(false);
    const {completion} = await f.block();
    await completion;
    expect(f.calls).toHaveLength(1);
    expect(f.compactions()[0]).toMatchObject({summary: "ready before threshold",
      providerReplayThroughEntryId: f.initialLeafId});
    expect(f.agent.state.messages.slice(1)).toEqual([tail]);
  } finally { await f.close(); }
});

test.each(["branch changed", "insufficient headroom"] as const)("completed native summary still refreshes when %s", async mode => {
  const f = await fixture(20_000);
  try {
    const source = await f.start(224_242);
    const result = nativeResult(source.preparation, "invalid ready summary");
    f.append(user(mode === "insufficient headroom" ? "new observation ".repeat(120_000) : "new observation"));
    f.first.resolve(result);
    await f.maintenance.speculationCompletion;
    if (mode === "branch changed") {
      const branch = f.manager.getBranch();
      f.manager.branch(branch.at(-3)!.id);
      f.append(assistant("changed snapshot leaf"));
      f.append(user("new branch observation"));
    }
    f.maintenance.maybeStartSpeculativeCompaction(253_573, contextWindow);
    await f.maintenance.speculationCompletion;
    expect(f.calls).toHaveLength(2);
    const {completion} = await f.block();
    await completion;
    expect(f.compactions()[0]).toMatchObject({summary: "fresh native summary"});
  } finally { await f.close(); }
});

test.each(["background failure", "invalidated branch"] as const)("waiting native speculation falls back after %s", async mode => {
  const f = await fixture();
  try {
    const source = await f.start();
    if (mode === "invalidated branch") {
      const branch = f.manager.getBranch();
      f.manager.branch(branch.at(-2)!.id);
      f.append(assistant("replacement snapshot leaf"));
      f.append(user("new branch request"));
    }
    const {completion} = await f.block();
    expect(source.signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.compactions()).toHaveLength(0);
    if (mode === "background failure") f.first.reject(new Error("offline native background failure"));
    else f.first.resolve(nativeResult(source.preparation, "stale native summary"));
    await completion;
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.options).toMatchObject({sessionId: f.manager.getSessionId(), preferWebsockets: true});
    expect(f.compactions()).toHaveLength(1);
    expect(f.compactions()[0]).toMatchObject({summary: "fresh native summary", method: "remote"});
    expect(f.maintenance.isCompacting).toBe(false);
    expect(f.maintenance.speculationState).toBe("idle");
  } finally { await f.close(); }
});

test("budget cancellation interrupts the native speculation wait without resend or late commit", async () => {
  const f = await fixture();
  try {
    const source = await f.start();
    const {completion} = await f.block();
    expect(source.signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(1);
    let settled = false;
    void completion.then(() => { settled = true; });
    f.maintenance.abortCompaction(new Error("run budget ended"));
    await tick();
    // The fake provider deliberately remains pending: cancellation must not wait for it to cooperate.
    expect(settled).toBe(true);
    expect(source.signal.aborted).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.compactions()).toHaveLength(0);
    expect(f.maintenance.isCompacting).toBe(false);
    expect(f.events.filter(event => event.type === "auto_compaction_end")).toEqual([
      expect.objectContaining({aborted: true, action: "remote"}),
    ]);
    f.first.resolve(nativeResult(source.preparation, "late ignored summary"));
    await tick();
    expect(f.compactions()).toHaveLength(0);
    expect(f.maintenance.speculationState).toBe("idle");
  } finally { await f.close(); }
});
