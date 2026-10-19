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

test("OMP refreshes Python tools after writes, edits and removal without exposing other host tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-omp-python-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), {recursive: true});
  const events: {type: string; data: any; trace: any}[] = [];
  const runtime = createTestRuntime({controllers: [], sensors: []}, (type, data, trace) => events.push({type, data, trace}));
  const control = new AbortController();
  let cycle: Cycle = {epoch: "python-epoch", signal: control.signal};
  let session: AgentSession | undefined;
  let refreshes = 0;
  const extension = createRsaExtension({runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    basewareSocket: "/tmp/unused-baseware.sock", binDir: resolveBin(),
    maxRequests: 20, autoObserve: [], cycle: () => cycle,
    refreshPythonTools: async tools => { refreshes++; await session!.refreshRpcHostTools(tools); },
  });
  const settings = Settings.isolated({"memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false});
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, {settings});
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  const baseTools = ["read", "write", "edit", "observe", "exec"];
  const source = `from rsa_tools import capability
import json, os
@capability
def calculate(value: int = 4):
    """Return the value plus one."""
    return {"value": value + 1, "epoch": os.environ["BASEWARE_EPOCH"], "trace": json.loads(os.environ["BASEWARE_TRACE"])}
`;
  const broken = `
@capability
def needs_type(value):
    """Parameter annotation is missing."""
    return value
`;
  const snapshots: {tools: string[]; schema: any; exclusive: boolean; messages: string}[] = [];
  let request = 0;
  try {
    ({session} = await createOmpSession({cwd: workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
      sessionManager: SessionManager.create(workspace, join(directory, "session")), systemPrompt: "Use the workspace tools.", cacheWarming: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
      disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
      toolNames: baseTools, customTools: extension.tools,
      preloadedPreparedExtensions: [{path: "rsa-python-test", resolvedPath: "rsa-python-test", factory: extension.factory, error: null}],
    }));
    session.agent.streamFn = async (_model, context) => {
      const tool = context.tools?.find(tool => tool.name.startsWith("python_"));
      const index = ++request;
      snapshots.push({tools: context.tools?.map(tool => tool.name) ?? [], schema: tool?.parameters,
        exclusive: !!tool && session!.agent.state.tools.find(active => active.name === tool.name)?.concurrency === "exclusive",
        messages: JSON.stringify(context.messages)});
      const call = (name: string, args: Record<string, unknown>) => [{type: "toolCall" as const, id: `call_${index}`, name, arguments: args}];
      let content: AssistantMessage["content"] = [{type: "text", text: "Finished."}];
      if (index === 1) content = call("write", {path: "actions.py", content: source + broken});
      if (index === 2) content = call(tool?.name ?? "missing-python-tool", {});
      if (index === 3) content = call("write", {path: "actions.py", content: source.replace("plus one", "plus two").replace("value + 1", "value + 2")});
      if (index === 4) content = call(tool?.name ?? "missing-python-tool", {value: 6});
      if (index === 5) content = call("exec", {command: "rm actions.py"});
      const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
        stopReason: index <= 5 ? "toolUse" : "stop",
        usage: {input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const stream = new AssistantMessageEventStream();
      stream.push({type: "done", reason: message.stopReason as "stop" | "toolUse", message});
      return stream;
    };
    await session.prompt("Create and use a Python capability, edit it, then remove it.");
    expect(request).toBe(6);
    expect(refreshes).toBe(3);
    expect(snapshots.map(snapshot => snapshot.tools.filter(name => name.startsWith("python_")).length)).toEqual([0, 1, 1, 1, 1, 0]);
    for (const snapshot of snapshots) expect(snapshot.tools.filter(name => !name.startsWith("python_")).sort()).toEqual([...baseTools].sort());
    expect(snapshots[1]!.schema).toMatchObject({properties: {value: {type: "integer", default: 4}}, required: [], additionalProperties: false});
    expect(snapshots[1]!.exclusive).toBe(true);
    expect(snapshots[1]!.messages).toContain("Parameter value requires a supported type annotation");
    const results = events.filter(event => event.type === "python_capability_result");
    expect(results.map(event => event.data.result.value)).toEqual([5, 8]);
    expect(results[0]!.data).toMatchObject({origin: {path: "actions.py", function: "calculate"}, result: {epoch: "python-epoch", trace: {epoch: "python-epoch", toolCallId: "call_2"}}});
    expect(results[1]!.data.codeSHA).not.toBe(results[0]!.data.codeSHA);
    expect(results[0]!.trace).toMatchObject({epoch: "python-epoch", toolCallId: "call_2"});
    expect(session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(5);

    await writeFile(join(workspace, "actions.py"), source);
    cycle = {...cycle, purpose: "consolidate"};
    await consolidateOmpSession(session, cycle.signal);
    expect(refreshes).toBe(3);
    expect(snapshots[6]!.tools.sort()).toEqual(["read", "write", "edit"].sort());
    cycle = {epoch: "next-epoch", signal: control.signal};
    await session.prompt("Continue after consolidation.");
    expect(refreshes).toBe(4);
    expect(snapshots[7]!.tools.filter(name => name.startsWith("python_"))).toHaveLength(1);
  } finally {
    await session?.dispose(); authStorage.close(); await runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
}, 30_000);

function resolveBin() { return join(import.meta.dir, "../bin"); }
