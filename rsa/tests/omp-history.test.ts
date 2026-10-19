import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildResponsesDeltaInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { createRsaExtension } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { captureResult, createTestRuntime } from "./runtime-fixture.ts";
import { Workspace } from "../src/harness/workspace.ts";

test.each([1, 26])("OMP persists batches of %i images and reuses the Codex prefix across tools and prompts", async (batchSize) => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-history-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const image = join(directory, "sample.png");
  await Bun.write(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  let captures = 0;
  const states: string[] = [];
  const events: { type: string; data: any }[] = [];
  const runtime = createTestRuntime({ controllers: [{
    id: "camera", requiresControl: false, mediaTypes: ["image/png"], help: () => "capture",
    async execute() {
      const position = Bun.file(join(workspace, "position"));
      states.push(await position.exists() ? await position.text() : "initial");
      return { ...captureResult(Array.from({ length: batchSize }, () => ({ id: `sample-${++captures}`, controllerId: "camera", mediaType: "image/png", path: image,
        timing: { clock: "test", requestedAtMs: captures, receivedAtMs: captures } }))), stdout: `interface-state-${captures}` };
    },
  }] }, (type, data) => { events.push({ type, data }); });
  const control = new AbortController();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", autoObserve: [{ controllerId: "camera", argv: [] }],
    maxRequests: 9, cycle: () => ({ epoch: "test", signal: control.signal }),
  });
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false,
    "retry.enabled": false, "retry.modelFallback": false, "title.refreshOnReplan": false });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")! as Model<"openai-codex-responses">;
  let manager = SessionManager.create(workspace, join(directory, "session"));
  const openSession = () => createOmpSession({
    cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
    sessionManager: manager, systemPrompt: "Inspect the supplied sensors.", cacheWarming: false,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
    toolNames: ["exec", "observe"], customTools: extension.tools,
    preloadedPreparedExtensions: [{ path: "rsa-test", resolvedPath: "rsa-test", factory: extension.factory, error: null }],
  });
  let { session } = await openSession();
  let requests = 0;
  let previous: Awaited<ReturnType<typeof buildTransformedCodexRequestBody>> | undefined;
  let responseItems: NonNullable<Awaited<ReturnType<typeof buildTransformedCodexRequestBody>>["input"]> = [];
  const deltas: unknown[] = [];
  const imageCounts: number[] = [];
  const textCounts: number[] = [];
  // Replace the transport itself: this exercises the SDK's real loop and persistence offline.
  const streamFn: typeof session.agent.streamFn = async (_model, context) => {
    const body = await buildTransformedCodexRequestBody(model, context, { reasoning: "low", sessionId: "offline" });
    if (previous) deltas.push(buildResponsesDeltaInput(previous, responseItems, body, { service_tier: true }));
    previous = structuredClone(body);
    imageCounts.push(context.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((p) => p.type === "image").length);
    const text = context.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(part => part.type === "text").map(part => part.text).join("\n");
    textCounts.push((text.match(/interface-state-\d+/g) ?? []).length);
    const index = ++requests;
    const done = index >= 7;
    const exec = (suffix: string, command: string) => ({ type: "toolCall" as const, id: `call_${index}_${suffix}`, name: "exec", arguments: { command } });
    const observe = (argv: string[] = []) => ({ type: "toolCall" as const, id: `call_${index}_observe`, name: "observe", arguments: { controllerId: "camera", argv } });
    const invalid = (suffix: string) => ({ type: "toolCall" as const, id: `call_${index}_${suffix}`, name: "exec", arguments: {} });
    const batches = [
      [invalid("bad_before"), exec("a", "printf first > position"), exec("b", "printf second > position"), invalid("bad_after")],
      [exec("a", "sleep 0.03; printf third > position"), observe()],
      [observe(), exec("a", "printf fourth > position")],
      [observe()],
      [observe(["detail"])], // The latest explicit sample satisfies this sensor regardless of arguments.
      [exec("a", "printf done")],
    ];
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: done ? [{ type: "text", text: "Observed." }] : batches[index - 1],
      stopReason: done ? "stop" : "toolUse",
      usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const withResponse = await buildTransformedCodexRequestBody(model, { ...context, messages: [...context.messages, message] }, { reasoning: "low", sessionId: "offline" });
    responseItems = withResponse.input!.slice(body.input!.length).filter((item) => item.type === "function_call" || item.type === "message");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  session.agent.streamFn = streamFn;
  try {
    await session.prompt("Explore.");
    await session.prompt("Continue.");
    expect(requests).toBe(8);
    const file = session.sessionFile!;
    await session.dispose();
    manager = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
    ({ session } = await openSession());
    session.agent.streamFn = streamFn;
    await session.prompt("Resume.");
    expect(requests).toBe(9);
    // One automatic capture per batch; an explicit final observe is reused.
    // The larger batch also crosses Codex's SDK cap of 200 retained images.
    expect(imageCounts).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10].map(n => n * batchSize));
    expect(textCounts).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(states).toEqual(["initial", "second", "third", "third", ...Array(6).fill("fourth")]);
    expect(events.filter(e => e.type === "observation" && e.data.origin === "explicit")).toHaveLength(4 * batchSize);
    const contexts = events.filter(e => e.type === "observation_context");
    expect(contexts).toHaveLength(9);
    expect(contexts.filter(e => e.data.reusedObservations.length)).toHaveLength(3);
    expect(contexts.filter(e => e.data.reusedObservations.length).every(e => e.data.freshObservations.length === 0)).toBe(true);
    expect(events.filter(e => e.type === "observation_media")).toHaveLength(10 * batchSize);
    expect(deltas).toHaveLength(8);
    expect(deltas.every((delta) => delta !== null)).toBe(true);
    const entries = manager.getEntries();
    expect(entries.filter((e) => e.type === "custom_message" && e.customType === "rsa-observation")).toHaveLength(3);
    const results = entries.filter((e) => e.type === "message" && e.message.role === "toolResult");
    expect(results).toHaveLength(11);
    expect(results.map(entry => entry.type === "message" && entry.message.role === "toolResult"
      ? entry.message.content.filter(part => part.type === "image").length : 0))
      .toEqual([0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1].map(n => n * batchSize));
  } finally {
    await session.dispose(); authStorage.close(); await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
