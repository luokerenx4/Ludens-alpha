import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_IMAGE_BUDGETS } from "@oh-my-pi/snapcompact";
import type { ControllerRequest } from "@playness/baseware/contracts";
import type { AgentRunner, Runtime } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import type { WorkspaceState } from "../workspace-state.ts";
import { openWorkspaceSession, selectWorkspaceSession } from "./workspace-session.ts";
import { createRsaExtension, type Cycle } from "./extension.ts";
import type { EventLog } from "../events.ts";
import { installCompactionHttpTrace, ModelTrace } from "./trace.ts";
import { SHIORI_SOURCE } from "./shiori.ts";
import prompt from "../../../prompts/explore.md" with { type: "text" };
import continuation from "../../../prompts/continue.md" with { type: "text" };
import consolidation from "../../../prompts/consolidate.md" with { type: "text" };

/** Run one maintenance turn inside the existing session, then restore its tools. */
export async function consolidateOmpSession(
  session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName" | "prompt" | "getLastAssistantMessage">,
  signal: AbortSignal,
) {
  const tools = session.getActiveToolNames();
  signal.throwIfAborted();
  try {
    await session.setActiveToolsByName(["read", "write", "edit"]);
    signal.throwIfAborted();
    await session.prompt(consolidation);
    signal.throwIfAborted();
    const last = session.getLastAssistantMessage();
    if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "Model request failed");
    if (last?.stopReason === "aborted") throw new Error("Consolidation aborted");
  } finally {
    await session.setActiveToolsByName(tools);
  }
}

// OMP 18.9.1 drops old images above its provider count cap (DeepSeek: fallback 5;
// Codex: 200). The 2026-10-13 wire trace exposed prefix rewrites despite stable
// session history, taking DeepSeek cache hits from 71.9% to 19.9% in one turn.
// Apply one Harness policy to every selected provider, including future ones:
// retain images until compaction. Token/body budgets and server limits remain.
// The SDK table is process-local; no provider allowlist or dependency patch.
export async function createOmpSession(options: Parameters<typeof createAgentSession>[0] & { model: Model }) {
  PROVIDER_IMAGE_BUDGETS[options.model.provider] = Infinity;
  const result = await createAgentSession(options);
  // The CustomTool adapter does not expose concurrency. Set it on the actual
  // AgentTools: an observation must wait for preceding environment actions.
  for (const tool of result.session.agent.state.tools) {
    if (tool.name === "exec" || tool.name === "observe") tool.concurrency = "exclusive";
  }
  return result;
}

export async function createOmpAgent(options: {
  runtime: Runtime; workspace: string; runDir: string; basewareSocket: string; rsaSocket: string;
  state: WorkspaceState;
  binDir: string; model: string; autoObserve: ControllerRequest[]; maxRequests: number;
  resume?: string;
  compactionThreshold?: number;
  log: EventLog;
}): Promise<AgentRunner> {
  let cycle: Cycle | undefined;
  // Native background summaries can finish between control cycles.
  const trace = new ModelTrace(options.log, () => ({ epoch: cycle?.epoch, ...extension.context() }));
  const extension = createRsaExtension({ ...options, clock: options.log.clock, trace: trace.current, workspace: new Workspace(options.workspace, options.state.versionsDir),
    cycle: () => {
      if (!cycle) throw new Error("No active control cycle");
      return cycle;
    },
  });
  const settings = Settings.isolated({
    "memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false,
    // Load the root AGENTS.md explicitly; growing run logs are not prompt context.
    "includeWorkspaceTree": false,
    // Experiment with the existing OMP compactor; keep its native history,
    // background preparation and image retention policy intact.
    ...(options.compactionThreshold === undefined ? {} : { "compaction.thresholdTokens": options.compactionThreshold }),
    // Keep full history server-side through OMP's native WS delta chain.
    // The pinned pi-ai patch routes oversized bootstrap frames through SSE
    // until native compaction, instead of repeatedly retrying close 1009.
    "providers.openaiWebsockets": "auto",
  });
  const authStorage = await discoverAuthStorage(undefined, { settings, cwd: options.workspace });
  // OMP's remote/background compactor bypasses agent.streamFn. This host-local
  // observer leaves its native requests and response streams untouched.
  const untraceCompaction = installCompactionHttpTrace(options.log, trace.compactionParent);
  let manager: SessionManager | undefined;
  let initializedSession: AgentSession | undefined;
  try {
    const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
    const slash = options.model.indexOf("/");
    const provider = options.model.slice(0, slash);
    const id = options.model.slice(slash + 1);
    const model = modelRegistry.find(provider, id);
    if (!model || !model.input.includes("image")) throw new Error(`An image-capable model is required: ${options.model}`);
    const extensionPath = resolve(import.meta.dir, "extension.ts");
    manager = await openWorkspaceSession(options.state, options.resume);
    const { session } = await createOmpSession({
      cwd: options.workspace, agentDir: join(options.runDir, "omp"),
      model, authStorage, modelRegistry, settings, sessionManager: manager, telemetry: trace.shiori.config,
      customSystemPrompt: prompt, thinkingLevel: ThinkingLevel.Low, cacheWarming: false,
      skills: [], rules: [], contextFiles: [{ path: join(options.workspace, "AGENTS.md"),
        content: await readFile(join(options.workspace, "AGENTS.md"), "utf8") }],
      promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: ["read", "write", "edit", "observe", "exec"], customTools: extension.tools,
      // Restricted sessions accept explicit prepared hooks and caller-supplied tools only.
      preloadedPreparedExtensions: [{ path: extensionPath, resolvedPath: extensionPath, factory: extension.factory, error: null }],
    });
    initializedSession = session;
    const sessionFile = await selectWorkspaceSession(options.state, manager);
    const unsubscribe = trace.attach(session);
    options.log.recorder(SHIORI_SOURCE)("session", { file: sessionFile, model: options.model, tools: session.getActiveToolNames() });
    return {
      async run(context) {
        cycle = context;
        try {
          let nextPrompt = context.message ? `${context.message}\n\n${continuation}` : continuation;
          while (!context.signal.aborted) {
            await session.prompt(nextPrompt);
            nextPrompt = continuation;
            const last = session.getLastAssistantMessage();
            if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "Model request failed");
            if (last?.stopReason === "aborted") break;
          }
        } finally { cycle = undefined; }
      },
      async consolidate(context) {
        cycle = { ...context, purpose: "consolidate" };
        try { await consolidateOmpSession(session, context.signal); }
        finally { cycle = undefined; }
      },
      abort: () => session.abort(),
      async close() {
        try { await session.dispose(); }
        finally { unsubscribe(); untraceCompaction(); await trace.shiori.close(); authStorage.close(); }
      },
    };
  } catch (error) {
    try {
      if (initializedSession) await initializedSession.dispose();
      else await manager?.close();
    } finally { untraceCompaction(); await trace.shiori.close(); authStorage.close(); }
    throw error;
  }
}
