import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "rsa-omp-observer-"));
  const workspace = join(directory, "workspace"), runDir = join(directory, "run");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const image = join(workspace, "raw.png");
  await Bun.write(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  const events: { type: string; data: any }[] = [];
  let captures = 0;
  const runtime = createTestRuntime({ controllers: [{ id: "camera", requiresControl: false, mediaTypes: ["image/png"], help: () => "capture",
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
  const baseTools = ["read", "write", "edit", "exec", "observe"];
  const source = (text: string, broken = false) => `class Perception:
    def start(self, context): pass
    def close(self): pass
    def observe(self):
        ${broken ? 'raise RuntimeError("observer needs repair")' : `return {"sequence": 1, "text": "${text}", "media": [{"path": "raw.png", "mediaType": "image/png"}]}`}
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
    session.agent.streamFn = async (_model, context) => {
      const messages = structuredClone(context.messages);
      const records = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).flatMap(part => {
        if (part.type !== "text") return [];
        try { return [JSON.parse(part.text)]; } catch { return []; }
      });
      snapshots.push({ tools: context.tools?.map(tool => tool.name) ?? [], messages,
        observation: records.findLast(value => value?.control && Array.isArray(value.observations)) });
      const index = snapshots.length;
      const sources = [source("adapted-v1"), source("adapted-v2"), broken, source("adapted-v3")];
      const content: AssistantMessage["content"] = index <= sources.length
        ? [{ type: "toolCall", id: `write-observer-${index}`, name: "write", arguments: { path: "perception.py", content: sources[index - 1] } },
           { type: "toolCall", id: `reload-${index}`, name: "exec", arguments: { command: "rsa perception reload" } }]
        : [{ type: "text", text: "Observer repaired." }];
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content, stopReason: index <= sources.length ? "toolUse" : "stop",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };
    await session.prompt("Build and improve an observation function.");
    expect(snapshots).toHaveLength(5);
    expect(snapshots.map(snapshot => snapshot.observation.perception.state))
      .toEqual(["unimplemented", "ready", "ready", "error", "ready"]);
    expect(snapshots[3]!.observation.perception.error).toContain("observer needs repair");
    expect(snapshots[0]!.observation.observations).toEqual([]);
    expect(snapshots[3]!.observation.observations).toEqual([]);
    expect(captures).toBe(0);
    for (const snapshot of snapshots) expect(snapshot.tools.toSorted()).toEqual(baseTools.toSorted());
    for (let index = 1; index < snapshots.length; index++) {
      const earlier = snapshots[index - 1]!.messages;
      expect(snapshots[index]!.messages.slice(0, earlier.length)).toEqual(earlier);
    }
    const adapted = snapshots.filter(snapshot => snapshot.observation.perception.state === "ready");
    expect(new Set(adapted.map(snapshot => snapshot.observation.perception.codeSHA)).size).toBe(3);
    for (const snapshot of adapted) {
      const observation = snapshot.observation.observations[0];
      expect(observation.path.startsWith(join(runDir, "observations"))).toBe(true);
      expect(await readFile(observation.path)).toEqual(await readFile(image));
    }
    const file = session.sessionFile!;
    await session.dispose(); session = undefined;
    const persisted = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
    expect(persisted.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(8);
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("raw-view-1");
    expect(saved).toContain("adapted-v1");
    expect(saved).toContain("observer needs repair");
    expect(events.filter(event => event.type === "perception_observe_end").map(event => event.data.status.state))
      .toEqual(["unimplemented", "ready", "ready", "error", "ready"]);
  } finally {
    await session?.dispose(); authStorage.close(); await runtime.close(); await closeServer();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
