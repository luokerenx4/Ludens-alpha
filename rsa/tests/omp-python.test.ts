import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
import { consolidateOmpSession, createOmpSession } from "../src/harness/omp/session.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test("workspace Python capabilities do not grow OMP's tool list across writes, removal or consolidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-omp-python-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), {recursive: true});
  const events: {type: string; data: any}[] = [];
  const runtime = createTestRuntime({controllers: []}, (type, data) => events.push({type, data}));
  const control = new AbortController();
  let cycle: Cycle = {epoch: "python-epoch", signal: control.signal};
  let session: AgentSession | undefined;
  const rsaSocket = "/tmp/unused-rsa.sock";
  const extension = createRsaExtension({runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    basewareSocket: "/tmp/unused-baseware.sock", rsaSocket, binDir: join(import.meta.dir, "../bin"),
    maxRequests: 20, cycle: () => cycle,
  });
  const settings = Settings.isolated({"memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false});
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, {settings});
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  const baseTools = ["read", "write", "edit", "observe", "bash"];
  const source = `from rsa_tools import capability
@capability
def calculate(value: int = 4):
    """Return the value plus one."""
    return value + 1
`;
  const snapshots: {tools: string[]; messages: string}[] = [];
  let request = 0;
  try {
    ({session} = await createOmpSession({cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")), systemPrompt: "Use rsa controller to discover capabilities.", cacheWarming: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: baseTools, customTools: extension.tools,
      preloadedPreparedExtensions: [{path: "rsa-python-test", resolvedPath: "rsa-python-test", factory: extension.factory, error: null}],
    }));
    // Exercise OMP's actual tool loop and extension hooks with an offline transport.
    session.agent.streamFn = async (_model, context) => {
      const index = ++request;
      snapshots.push({tools: context.tools?.map(tool => tool.name) ?? [], messages: JSON.stringify(context.messages)});
      const call = (name: string, args: Record<string, unknown>) => [{type: "toolCall" as const, id: `call_${index}`, name, arguments: args}];
      let content: AssistantMessage["content"] = [{type: "text", text: "Finished."}];
      if (index === 1) content = call("write", {path: "actions.py", content: source});
      if (index === 2) content = call("write", {path: "actions.py", content: source.replace("plus one", "plus two").replace("value + 1", "value + 2")});
      if (index === 3) content = call("bash", {command: "rm actions.py && printf '%s|%s' \"$RSA_SOCKET\" \"$BASEWARE_EPOCH\""});
      const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
        stopReason: index <= 3 ? "toolUse" : "stop",
        usage: {input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const stream = new AssistantMessageEventStream();
      stream.push({type: "done", reason: message.stopReason as "stop" | "toolUse", message});
      return stream;
    };
    await session.prompt("Create a Python capability, update it, then remove it.");
    expect(request).toBe(4);
    for (const snapshot of snapshots) {
      expect(snapshot.tools.sort()).toEqual([...baseTools].sort());
      expect(snapshot.messages).not.toContain("workspaceCapabilities");
    }
    const shellResult = session.sessionManager.getEntries().find(entry => entry.type === "message"
      && entry.message.role === "toolResult" && entry.message.toolName === "bash");
    expect(JSON.stringify(shellResult)).toContain(`${rsaSocket}|python-epoch`);
    expect(events.some(event => event.type === "python_capability" || event.type === "python_capability_result")).toBe(false);
    expect(session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(3);

    await writeFile(join(workspace, "actions.py"), source);
    cycle = {...cycle, purpose: "consolidate"};
    await consolidateOmpSession(session, cycle.signal);
    expect(snapshots[4]!.tools.sort()).toEqual(["read", "write", "edit"].sort());
    cycle = {epoch: "next-epoch", signal: control.signal};
    await session.prompt("Continue after consolidation.");
    expect(snapshots[5]!.tools.sort()).toEqual([...baseTools].sort());
  } finally {
    await session?.dispose(); authStorage.close(); await runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
}, 30_000);
