import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
import { consolidateOmpSession, createOmpSession } from "../src/harness/omp/session.ts";
import { captureResult, readTestController, createTestRuntime, installTestPerception } from "./runtime-fixture.ts";
import { Workspace } from "../src/harness/workspace.ts";

test("consolidation uses the same session with file tools, records memory reads, and skips sensors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-consolidation-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  const note = join(workspace, "memory", "current.md");
  await writeFile(note, "Current observation from play.\n");
  const image = join(directory, "sample.png");
  await Bun.write(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  let captures = 0;
  const events: { type: string; data: any; epoch?: string }[] = [];
  const runtime = createTestRuntime({ controllers: [{
    tool: { name: "camera", description: "capture", inputSchema: { type: "object" } }, requiresControl: false, mediaTypes: ["image/png"],
    async execute() {
      return captureResult([{ id: `sample-${++captures}`, controllerId: "camera", mediaType: "image/png", path: image,
        timing: { clock: "test", requestedAtMs: captures, receivedAtMs: captures } }]);
    },
  }] }, (type, data, trace) => events.push({ type, data, epoch: trace?.epoch }));
  installTestPerception(runtime, workspace, directory, (signal, trace) =>
    readTestController(runtime, "camera", {}, signal, trace));
  const control = new AbortController();
  let cycle: Cycle = { epoch: "play-before", signal: control.signal };
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp",
    maxRequests: 5, cycle: () => cycle,
  });
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false,
    "retry.enabled": false, "retry.modelFallback": false, "title.refreshOnReplan": false });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  const manager = SessionManager.create(workspace, join(directory, "session"));
  const { session } = await createOmpSession({
    cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
    sessionManager: manager, systemPrompt: "Learn from the supplied observations.", cacheWarming: false,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
    toolNames: ["read", "write", "edit", "observe", "bash"], customTools: extension.tools,
    preloadedPreparedExtensions: [{ path: "rsa-test", resolvedPath: "rsa-test", factory: extension.factory, error: null }],
  });
  const originalTools = session.getActiveToolNames();
  const originalFile = session.sessionFile;
  let consolidationRequests = 0;
  const surfaces: string[][] = [];
  session.agent.streamFn = async (_model, context) => {
    const consolidating = cycle.purpose === "consolidate";
    const index = consolidating ? ++consolidationRequests : 0;
    if (consolidating) {
      surfaces.push(context.tools?.map(tool => tool.name).sort() ?? []);
      expect(context.messages.some(message => message.role === "assistant" &&
        message.content.some(part => part.type === "text" && part.text === "Earlier gameplay retained."))).toBe(true);
    }
    const content: AssistantMessage["content"] = index === 1
      ? [{ type: "toolCall", id: "read_memory", name: "read", arguments: { path: "memory/current.md" } }]
      : index === 2
        ? [{ type: "toolCall", id: "write_memory", name: "write", arguments: { path: "memory/current.md", content: "Consolidated observation.\n" } }]
        : [{ type: "text", text: consolidating ? "Consolidation complete." : "Earlier gameplay retained." }];
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
      stopReason: index === 1 || index === 2 ? "toolUse" : "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  try {
    await session.prompt("Explore.");
    expect(captures).toBe(1);
    cycle = { epoch: "consolidate", signal: control.signal, purpose: "consolidate" };
    await consolidateOmpSession(session, control.signal);
    expect(captures).toBe(1);
    expect(session.sessionFile).toBe(originalFile);
    expect(session.getActiveToolNames()).toEqual(originalTools);
    expect(consolidationRequests).toBe(3);
    expect(surfaces).toEqual(Array.from({ length: 3 }, () => ["edit", "read", "write"]));
    expect(await readFile(note, "utf8")).toBe("Consolidated observation.\n");
    expect(events.filter(event => event.epoch === "consolidate" && event.type === "observation")).toHaveLength(0);
    expect(events.filter(event => event.epoch === "consolidate" && event.type === "perception_observe_start")).toHaveLength(0);
    expect(events.find(event => event.epoch === "consolidate" && event.type === "read")?.data)
      .toMatchObject({ path: note, hash: expect.any(String), isError: false });
    const contexts = events.filter(event => event.epoch === "consolidate" && event.type === "observation_context");
    // Reading unchanged memory does not append another full context block.
    // Writing it produces a new version receipt without starting perception.
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.data).toMatchObject({ observations: [], queries: [], purpose: "consolidate" });
    const initial = events.find(event => event.epoch === "play-before" && event.type === "observation_context")!;
    expect(initial.data.memoryVersion).not.toBe(contexts[0]!.data.memoryVersion);
    expect(extension.context().memoryVersion).toBe(contexts[0]!.data.memoryVersion);
    cycle = { epoch: "play-after", signal: control.signal };
    await session.prompt("Continue playing.");
    expect(captures).toBe(2);
  } finally {
    await session.dispose(); authStorage.close(); await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test.each(["prompt failure", "abort during tool change"])("consolidation restores tools after %s", async (failure) => {
  const control = new AbortController();
  const original = ["read", "write", "edit", "observe", "bash"];
  const changes: string[][] = [];
  let prompts = 0;
  const session: Parameters<typeof consolidateOmpSession>[0] = {
    getActiveToolNames: () => [...original],
    async setActiveToolsByName(names) {
      changes.push([...names]);
      if (changes.length === 1 && failure === "abort during tool change") control.abort();
    },
    async prompt() { prompts++; throw new Error("offline prompt failure"); },
    getLastAssistantMessage: () => undefined,
  };
  await expect(consolidateOmpSession(session, control.signal)).rejects.toThrow();
  expect(changes).toEqual([["read", "write", "edit"], original]);
  expect(prompts).toBe(failure === "prompt failure" ? 1 : 0);
});
