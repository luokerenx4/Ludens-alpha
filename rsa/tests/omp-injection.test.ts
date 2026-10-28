import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { createRsaExtension } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { listen } from "../src/harness/transport.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test("OMP can disable automatic perception while recording video and explicitly reading cold history", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rsa-omp-injection-")));
  const workspace = join(directory, "workspace"), runDir = join(directory, "run");
  await mkdir(join(workspace, "skills"), { recursive: true });
  await writeFile(join(workspace, "frame.png"), encodeRawPng(Uint8Array.from(
    Array.from({ length: 16 * 16 }, () => [220, 20, 20]).flat()), 16, 16, 3));
  await writeFile(join(workspace, "perception.py"), `from rsa_tools import capability, record
class Perception:
    sample_hz = 20
    def start(self, context): self.count = 0
    def close(self): pass
    @record
    @capability
    def sample(self):
        self.count += 1
        return {"text": "sample-" + str(self.count), "data": {"count": self.count},
                "space": {"frame": "offline-camera"}, "media": [{"path": "frame.png", "mediaType": "image/png"}]}
`);
  const events: { type: string; data: any; trace: any }[] = [];
  const runtime = createTestRuntime({ controllers: [] }, (type, data, trace) => events.push({ type, data, trace }));
  runtime.perception = new PerceptionRuntime({ workspace, runDir, record: runtime.record,
    env: { RSA_PERCEPTION_HOT_SECONDS: "0.1", RSA_VIDEO_SEGMENT_SECONDS: "1" } });
  const socket = `/tmp/rsa-omp-injection-${crypto.randomUUID()}.sock`;
  const closeServer = await listen(socket, runtime);
  const abort = new AbortController();
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  let session: AgentSession | undefined;
  const snapshots: { messages: any[]; images: any[]; json: any[]; text: string }[] = [];
  const timeline = join(workspace, ".rsa", "timeline");
  const records = async (): Promise<any[]> => (await Promise.all((await readdir(join(timeline, "segments")))
    .filter(name => name.endsWith(".jsonl")).sort().map(async name => (await readFile(join(timeline, "segments", name), "utf8"))
      .split("\n").filter(Boolean).map(line => JSON.parse(line))))).flat();
  const until = async (ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await ready()) && Date.now() < deadline) await Bun.sleep(20);
    expect(await ready()).toBe(true);
  };
  try {
    await runtime.perception.reload();
    await until(async () => runtime.perception!.status().state === "ready");
    const generation = runtime.perception.status().generation;
    const { epoch } = await runtime.start();
    const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")), runDir,
      basewareSocket: "/tmp/unused.sock", rsaSocket: socket, binDir: resolve(import.meta.dir, "../bin"),
      maxRequests: 12, cycle: () => ({ epoch: epoch!, signal: abort.signal }) });
    ({ session } = await createOmpSession({ cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")), systemPrompt: "Exercise local observation controls.",
      cacheWarming: false, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: ["bash", "observe"], customTools: extension.tools,
      preloadedPreparedExtensions: [{ path: "rsa-injection-test", resolvedPath: "rsa-injection-test", factory: extension.factory, error: null }],
    }));
    let history: any[] = [];
    let after: number | undefined;
    session.agent.streamFn = async (_model, context) => {
      const messages = structuredClone(context.messages);
      const previous = snapshots.at(-1)?.messages ?? [];
      const added = messages.slice(previous.length).flatMap(message => Array.isArray(message.content) ? message.content : []);
      const text = added.filter(part => part.type === "text").map(part => part.text).join("\n");
      const json = added.flatMap(part => {
        if (part.type !== "text") return [];
        try { return [JSON.parse(part.text)]; } catch { return []; }
      });
      snapshots.push({ messages, images: added.filter(part => part.type === "image"), json, text });
      const index = snapshots.length;
      if (index === 6) after = json.find(value => value.records)?.nextAfter;
      const calls: Record<number, { name: string; arguments: Record<string, unknown> }> = {
        1: { name: "bash", arguments: { command: "rsa perception inject off" } },
        3: { name: "bash", arguments: { command: "printf 'ordinary local work\\n'" } },
        4: { name: "observe", arguments: { id: history[0]?.id } },
        5: { name: "observe", arguments: { start: history[0]?.recordedAt, end: history.at(-1)?.recordedAt, limit: 2 } },
        6: { name: "observe", arguments: { start: history[0]?.recordedAt, end: history.at(-1)?.recordedAt, after, limit: 64 } },
        7: { name: "bash", arguments: { command: "rsa perception inject on" } },
      };
      const call = calls[index];
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: call ? [{ type: "toolCall", id: `call-${index}`, ...call }] : [{ type: "text", text: "Done." }],
        stopReason: call ? "toolUse" : "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };

    await session.prompt("Disable automatic attachment without stopping recording.");
    expect(snapshots).toHaveLength(2);
    expect(runtime.perceptionInjectionEnabled()).toBe(false);
    const readsWhenOff = events.filter(event => event.type === "perception_observe_end").length;
    const offSequence = (await records()).at(-1)!.sequence;
    await until(async () => {
      const all = await records();
      if (all.at(-1)!.sequence < offSequence + 8) return false;
      history = all.filter(record => record.sequence > offSequence).slice(0, 6);
      const states = await Promise.all(history.map(record => readFile(join(timeline, record.media[0].timeline.asset + ".json"), "utf8")
        .then(value => JSON.parse(value).status).catch(() => "pending")));
      return states.every(state => state === "ready") && Date.now() - Date.parse(history.at(-1)!.recordedAt) > 150;
    });
    expect(runtime.perception.status()).toMatchObject({ state: "ready", generation });
    expect(events.filter(event => event.type === "perception_observe_end")).toHaveLength(readsWhenOff);
    expect(history).toHaveLength(6);
    expect(await Bun.file(join(timeline, history[0].media[0].timeline.asset)).exists()).toBe(true);

    await session.prompt("Perform local work, inspect retained history, then re-enable automatic attachment.");
    expect(snapshots).toHaveLength(8);
    expect(snapshots[0]!.images).toHaveLength(1);
    for (const index of [1, 2, 3]) {
      expect(snapshots[index]!.images).toEqual([]);
      expect(snapshots[index]!.text).not.toContain("Perception is stopped");
      expect(snapshots[index]!.json.some(value => value.perception || value.records || value.snapshot || value.observations)).toBe(false);
      if (index === 1) expect(snapshots[index]!.json.find(value => value.control)?.control.context.perceptionInjection).toBe(false);
      else expect(snapshots[index]!.json.some(value => value.control || value.skills)).toBe(false);
    }
    const idRead = snapshots[4]!, firstPage = snapshots[5]!, secondPage = snapshots[6]!;
    const idMetadata = idRead.json.find(value => value.records);
    expect(idRead.images).toHaveLength(1);
    expect(idMetadata.records[0]).toMatchObject({ id: history[0].id, recordedAt: history[0].recordedAt,
      text: history[0].text, data: history[0].data, space: history[0].space });
    expect(idMetadata.result).toBeUndefined();
    expect(idMetadata.snapshot).toBeUndefined();
    expect(idRead.json.filter(value => value.records)).toHaveLength(1);
    const page = firstPage.json.find(value => value.records), continuation = secondPage.json.find(value => value.records);
    expect(firstPage.images).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextAfter).toBe(history[1].sequence);
    expect(secondPage.images).toHaveLength(4);
    expect(continuation.hasMore).toBe(false);
    expect([...page.records, ...continuation.records].map(record => record.id)).toEqual(history.map(record => record.id));
    expect(snapshots[7]!.images).toHaveLength(1);
    expect(snapshots[7]!.json.find(value => value.control)?.control.context.perceptionInjection).toBe(true);
    expect(runtime.perception.status()).toMatchObject({ state: "ready", generation });

    const explicit = session.sessionManager.getEntries().flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "observe" ? [entry.message] : []);
    expect(explicit).toHaveLength(3);
    const details = explicit[0]!.details as any;
    expect(details).toEqual({ queryId: expect.any(String), ok: true });
    // Only the two enabled automatic reads and the three explicit queries ran.
    expect(events.filter(event => event.type === "perception_observe_end")).toHaveLength(5);
    const recordedRead = events.find(event => event.type === "perception_observe_end" && event.data.query?.id === history[0].id);
    expect(recordedRead?.data).toMatchObject({ queryId: details.queryId, ok: true,
      records: [{ id: history[0].id, media: [{ timeline: { video: history[0].media[0].timeline.video } }] }] });
    expect(events.filter(event => event.type === "context_policy").map(event => event.data.perceptionInjection)).toEqual([false, true]);
  } finally {
    await session?.dispose(); authStorage.close(); await runtime.close(); await closeServer();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
