import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRsaExtension } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { listen } from "../src/harness/transport.ts";
import { captureResult, createTestRuntime } from "./runtime-fixture.ts";

test("OMP bootstraps empty perception and repairs it through the real reload CLI without default images", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rsa-omp-observer-")));
  const workspace = join(directory, "workspace"), runDir = join(directory, "run");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const image = join(workspace, "raw.png");
  await Bun.write(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  const events: { type: string; data: any }[] = [];
  let captures = 0;
  const runtime = createTestRuntime({ controllers: [{ tool: { name: "camera", description: "capture", inputSchema: { type: "object" } }, requiresControl: false, mediaTypes: ["image/png"],
    async execute() {
      const index = ++captures;
      return { ...captureResult([{ id: `raw-${index}`, controllerId: "camera", mediaType: "image/png", path: image,
        timing: { clock: "test", requestedAtMs: index, receivedAtMs: index } }]), stdout: `raw-view-${index}` };
    },
  }] }, (type, data) => events.push({ type, data }));
  const abort = new AbortController();
  const socket = `/tmp/rsa-perception-${crypto.randomUUID()}.sock`;
  const closeServer = await listen(socket, runtime);
  runtime.perception = new PerceptionRuntime({ workspace, runDir, record: runtime.record });
  await runtime.perception.reload();
  const { epoch } = await runtime.start();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")), runDir,
    basewareSocket: "/tmp/unused.sock", rsaSocket: socket, binDir: resolve(import.meta.dir, "../bin"),
    maxRequests: 10, cycle: () => ({ epoch: epoch!, signal: abort.signal }),
  });
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  const manager = SessionManager.create(workspace, join(directory, "session"));
  const baseTools = ["read", "write", "edit", "bash", "observe"];
  const source = (text: string, broken = false) => `from rsa_tools import capability, record
class Perception:
    def start(self, context): pass
    def close(self): pass
    @record
    @capability
    def sample(self):
        ${broken ? 'raise RuntimeError("observer needs repair")' : `return {"text": "${text}", "media": [{"path": "raw.png", "mediaType": "image/png"}]}`}
`;
  const broken = source("unused", true);
  let session: AgentSession | undefined;
  const snapshots: { tools: string[]; messages: any[]; observation: any }[] = [];
  try {
    ({ session } = await createOmpSession({ cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
      sessionManager: manager, systemPrompt: "Adapt your observation in the workspace.", cacheWarming: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: baseTools, customTools: extension.tools,
      preloadedPreparedExtensions: [{ path: "rsa-observe-test", resolvedPath: "rsa-observe-test", factory: extension.factory, error: null }],
    }));
    let call = 0;
    session.agent.streamFn = async (_model, context) => {
      const messages = structuredClone(context.messages);
      const records = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).flatMap(part => {
        if (part.type !== "text") return [];
        try { return [JSON.parse(part.text)]; } catch { return []; }
      });
      snapshots.push({ tools: context.tools?.map(tool => tool.name) ?? [], messages,
        observation: Object.assign({}, ...records.slice(records.findLastIndex(value => value?.perception))) });
      call++;
      const repairs = call === 1 || call === 2 || call === 5;
      const content: AssistantMessage["content"] = repairs
        ? [{ type: "toolCall", id: `write-observer-${call}`, name: "write", arguments: { path: "perception.py",
            content: call === 2 ? broken : source(`adapted-v${call === 5 ? 3 : 1}`) } },
           { type: "toolCall", id: `reload-${call}`, name: "bash", arguments: { command: "rsa perception reload; sleep 0.15" } }]
        : [{ type: "text", text: `Step ${call}.` }];
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content, stopReason: repairs ? "toolUse" : "stop",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };
    // Perception only speaks at prompt starts; mid-round sampler transitions stay silent.
    await session.prompt("Build and improve an observation function."); // write v1, break it, final
    await session.prompt("Check the observer."); // boundary state: error
    await session.prompt("Repair the observer."); // unchanged state stays quiet, then repair
    await session.prompt("Verify the repair."); // boundary state: ready, fresh records
    expect(snapshots).toHaveLength(7);
    expect(snapshots.map(snapshot => snapshot.observation.perception.state))
      .toEqual(["unimplemented", "unimplemented", "unimplemented", "error", "error", "error", "ready"]);
    expect(snapshots[3]!.observation.perception.error).toContain("observer needs repair");
    expect(snapshots[0]!.observation.records).toBeUndefined();
    expect(snapshots[3]!.observation.records).toBeUndefined();
    expect(captures).toBe(0);
    for (const snapshot of snapshots) expect(snapshot.tools.toSorted()).toEqual(baseTools.toSorted());
    // OMP stamps completedAt/contextSnapshot onto earlier messages between prompts.
    const stable = (messages: unknown[]) => messages.map(message => {
      if (!message || typeof message !== "object") return message;
      const { completedAt: _completedAt, contextSnapshot: _contextSnapshot, ...rest } = message as Record<string, unknown>;
      return rest;
    });
    for (let index = 1; index < snapshots.length; index++) {
      const earlier = stable(snapshots[index - 1]!.messages);
      expect(stable(snapshots[index]!.messages).slice(0, earlier.length)).toEqual(earlier);
    }
    const repaired = snapshots[6]!;
    expect(repaired.observation.perception.codeSHA).toBeString();
    const record = repaired.observation.records[0];
    expect(record.id).toBeString();
    expect(record.recordedAt).toBeString();
    expect(record.media).toEqual([{ id: `${record.id}-0`, mediaType: "image/png" }]);
    expect(repaired.observation.snapshot).toBeUndefined();
    expect(repaired.observation.result).toBeUndefined();
    expect(repaired.observation.control?.perception).toBeUndefined();
    // The query keeps provenance once; model messages carry only the selected view.
    const ready = events.find(event => event.type === "perception_observe_end" && event.data.ok)!;
    expect(ready.data.records[0].media[0].timeline.asset.startsWith("video/")).toBe(true);
    expect(ready.data.records[0].media[0].timeline.video.width).toBe(32);
    const file = session.sessionFile!;
    await session.dispose(); session = undefined;
    const persisted = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
    expect(persisted.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(6);
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("raw-view-1");
    expect(saved).toContain("adapted-v1");
    expect(saved).toContain("observer needs repair");
    expect(events.filter(event => event.type === "perception_observe_end").map(event => event.data.ok))
      .toEqual([true]); // known unavailable samplers generate state changes, not failed queries
  } finally {
    await session?.dispose(); authStorage.close(); await runtime.close(); await closeServer();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
