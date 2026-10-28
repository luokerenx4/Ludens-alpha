import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as z from "@oh-my-pi/omptype/zod";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test("native OMP handback aborts the active tool and skips queued tool side effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-omp-handback-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in offline handback test"));
  const errors: unknown[] = [];
  const runtime = createTestRuntime({ controllers: [] }, (type, data) => { if (type === "error") errors.push(data); });
  const settings = Settings.isolated({ "retry.modelFallback": false, "title.refreshOnReplan": false });
  const auth = await AuthStorage.create(join(directory, "auth.db"));
  auth.keys.setRuntime("openai-codex", "offline-test-only");
  const registry = new ModelRegistry(auth, undefined, { settings });
  const model = registry.find("openai-codex", "gpt-6.1-sol")!;
  let cycle: Cycle | undefined;
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 10,
    cycle: () => { if (!cycle) throw new Error("No active control cycle"); return cycle; },
  });
  const parameters = z.object({});
  const started = Promise.withResolvers<void>();
  const executed: string[] = [];
  let activeAborted = false;
  const heldTool: CustomTool<typeof parameters> = {
    name: "hold", label: "Hold", description: "Wait for cancellation in an offline fixture.", parameters,
    async execute(_id, _params, _onUpdate, _ctx, signal) {
      executed.push("hold");
      if (!signal) throw new Error("OMP did not provide a tool abort signal");
      signal.throwIfAborted();
      const cancelled = new Promise<void>(resolve => signal.addEventListener("abort", () => {
        activeAborted = true;
        resolve();
      }, { once: true }));
      started.resolve();
      await cancelled;
      return { content: [{ type: "text", text: "Cancelled by native OMP." }] };
    },
  };
  const queuedTool: CustomTool<typeof parameters> = {
    name: "queued_write", label: "Queued write", description: "Record a side effect that handback must prevent.", parameters,
    async execute() {
      executed.push("queued_write");
      return { content: [{ type: "text", text: "Unexpected queued side effect." }] };
    },
  };
  try {
    const { session } = await createOmpSession({ cwd: workspace, agentDir: join(directory, "omp"), model,
      authStorage: auth, modelRegistry: registry, settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")),
      systemPrompt: "Exercise an offline tool batch.", cacheWarming: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: ["hold", "queued_write"], customTools: [heldTool, queuedTool],
      preloadedPreparedExtensions: [{ path: "rsa-handback-test", resolvedPath: "rsa-handback-test", factory: extension.factory, error: null }],
    });
    // The SDK adapter does not expose concurrency. The first tool owns the
    // exclusive slot, so the second is prepared but cannot start before it ends.
    for (const tool of session.agent.state.tools) tool.concurrency = "exclusive";
    const removeGate = session.agent.addBeforeModelCall(() =>
      cycle && !cycle.signal.aborted ? undefined : { stop: true, reason: "RSA control cycle is inactive" });
    let requests = 0;
    session.agent.streamFn = async () => {
      requests++;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [
          { type: "toolCall", id: "active-call", name: "hold", arguments: {} },
          { type: "toolCall", id: "queued-call", name: "queued_write", arguments: {} },
        ],
        stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    };
    runtime.agent = {
      async run(context) {
        cycle = context;
        try { await session.prompt("Run both tools in order."); }
        finally { cycle = undefined; }
      },
      async consolidate() {},
      abort: () => session.abort(),
      async close() { removeGate(); await session.dispose(); },
    };
    await runtime.start();
    await started.promise;
    await runtime.stop("human");
    await runtime.runSettled;
    expect(activeAborted).toBe(true);
    expect(executed).toEqual(["hold"]);
    expect(requests).toBe(1);
    expect(session.agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "queued-call"))
      .toMatchObject({ isError: true });
    expect(runtime.status()).toMatchObject({ mode: "manual", reason: "human", thinking: false });
    expect(errors).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    auth.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
