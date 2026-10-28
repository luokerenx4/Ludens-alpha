import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../src/harness/baseware.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { EventLog } from "../src/harness/events.ts";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { ModelTrace } from "../src/harness/omp/trace.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen as listenRsa } from "../src/harness/transport.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { pythonExecutable } from "../../shared/python.ts";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { encodeTerminalImage, TerminalGraphicsDecoder } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error("Native bash integration condition timed out");
    await Bun.sleep(20);
  }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
const tool = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"] =>
  [{ type: "toolCall", id, name, arguments: args }];

/**
 * Offline contract for replacing RSA exec: real OMP tools/process supervisor,
 * real RSA/Baseware sockets, synthetic model responses and a fake input device.
 * No provider request, local credentials, emulator or existing workspace.
 */
async function fixture() {
  const originalEnvironment = new Map([
    "PATH", "PYTHONPATH", "RSA_PYTHON", "RSA_ARTIFACT_ROOT", "RSA_SOCKET", "RSA_WORKSPACE", "RSA_RUN_ID", "BASEWARE_SOCKET",
    "BASEWARE_EPOCH", "BASEWARE_TRACE", "RSA_EPOCH", "RSA_TRACE",
  ].map(key => [key, process.env[key]]));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rsa-native-bash-")));
  const workspace = join(directory, "workspace"), runDir = join(directory, "run");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const prefix = `/tmp/rsa-bash-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const log = new EventLog(runDir, { id: "native-bash-run", now: () => performance.now() });
  const actions: { args: Record<string, unknown>; epoch?: string }[] = [];
  let held = false, cancelled = 0, released = 0;
  const core = new BasewareCore({ record: log.record, drivers: [{ id: "offline", version: "1" }], capabilities: {
    controllers: [{ tool: { name: "pad.echo", description: "Echo a label or hold for cancellation", inputSchema: { type: "object" } }, requiresControl: true,
      async release() { held = false; released++; },
      async execute(args, { epoch, signal }) {
        actions.push({ args: {...args}, epoch });
        if (args.label === "hold") {
          held = true;
          await new Promise<void>(done => signal.addEventListener("abort", () => { cancelled++; done(); }, { once: true }));
        }
        return { id: crypto.randomUUID(), status: signal.aborted ? "interrupted" as const : "completed" as const,
          exitCode: signal.aborted ? 130 : 0, stdout: JSON.stringify(args), stderr: "", result: { content: [] },
          timing: { clock: "offline", requestedAtMs: 1, receivedAtMs: 2 } };
      },
    }],
  } });
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({ socket: basewareSocket, seconds: 60, runDir, record: log.record });
  const runtime = new Runtime(devices, log.record, 60, log.clock.id);
  runtime.controller = new WorkspaceController({ workspace, devices, env: {}, record: log.record });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  const control = new AbortController();
  let cycle: Cycle | undefined = { epoch: (await runtime.start()).epoch!, signal: control.signal };
  const trace = new ModelTrace(log, () => ({ epoch: cycle?.epoch }));
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    runDir, basewareSocket, rsaSocket, binDir: resolve(import.meta.dir, "../bin"), maxRequests: 50, trace: trace.current,
    cycle: () => { if (!cycle) throw new Error("No active control cycle"); return cycle; } });
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "retry.enabled": false,
    "retry.modelFallback": false, "title.refreshOnReplan": false, "async.enabled": true, "launch.enabled": true });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  const baseTools = ["read", "write", "edit", "observe", "bash", "wait"];
  const { session } = await createOmpSession({ cwd: workspace, agentDir: join(directory, "omp"), model,
    authStorage, modelRegistry, settings, sessionManager: SessionManager.create(workspace, join(directory, "session")),
    systemPrompt: "Use the native bash and proc tools.", cacheWarming: false, telemetry: trace.shiori.config,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    disableExtensionDiscovery: true, restrictToolNames: true, allowRestrictedCustomTools: true,
    toolNames: baseTools, customTools: extension.tools,
    preloadedPreparedExtensions: [{ path: "rsa-bash-test", resolvedPath: "rsa-bash-test", factory: extension.factory, error: null }],
  });
  const removeControlGate = session.agent.addBeforeModelCall(() =>
    cycle && !cycle.signal.aborted ? undefined : { stop: true, reason: "No active RSA control cycle" });
  let scripted: AssistantMessage["content"][] = [];
  const toolsSeen: string[][] = [];
  const deliveriesSeen: string[][] = [];
  const results = new Map<string, any>();
  session.subscribe(event => {
    if (event.type === "tool_execution_end") results.set(event.toolCallId, event.result);
  });
  session.agent.streamFn = async (_model, context) => {
    toolsSeen.push(context.tools?.map(value => value.name).toSorted() ?? []);
    deliveriesSeen.push([...extension.context().deliveryIds]);
    const content = scripted.shift() ?? [{ type: "text", text: "Turn complete." }];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  const detachTrace = trace.attach(session);
  return { workspace, runDir, rsaSocket, basewareSocket, runtime, core, session, extension, results, actions, toolsSeen, deliveriesSeen, baseTools,
    epoch: () => cycle!.epoch, held: () => held, cancelled: () => cancelled, released: () => released,
    clearCycle() { cycle = undefined; },
    async prompt(...calls: AssistantMessage["content"][]) {
      scripted = structuredClone(calls);
      await session.prompt("Continue the offline process lifecycle experiment.");
      expect(scripted).toHaveLength(0);
      // Environment injection must not rewrite provider-owned tool-call history:
      // WS continuation and prompt caching depend on the original arguments.
      for (const call of calls.flat()) {
        if (call.type !== "toolCall" || call.name !== "bash") continue;
        const saved = session.agent.state.messages
          .flatMap(message => message.role === "assistant" ? message.content : [])
          .find(part => part.type === "toolCall" && part.id === call.id);
        expect(saved).toMatchObject({ type: "toolCall", arguments: call.arguments });
      }
    },
    async nextEpoch() {
      cycle = { epoch: (await runtime.start()).epoch!, signal: new AbortController().signal };
    },
    async events() {
      return (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
    async close() {
      try {
        await runtime.close();
        await session.dispose();
        removeControlGate();
        detachTrace();
        await trace.shiori.close();
        authStorage.close();
        // OMP owns services in its project broker; close only this isolated scope.
        const broker = await daemonClientForProject(workspace);
        try { await broker.request({ op: "shutdown" }); } finally { broker.close(); }
        devices.close();
        await closeRsa();
        await closeBaseware();
        await rm(directory, { recursive: true, force: true });
        await rm(rsaSocket, { force: true });
      } finally {
        for (const [key, value] of originalEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        refreshShellConfigCache();
      }
    },
  };
}

const worker = `import json, os, subprocess, sys, time
from pathlib import Path
from rsa_tools import Client, capability
from baseware import Client as Device

@capability
def act(label: str):
    return Client().call("controller/pad.echo", {"label": label})

def attempt(call):
    try: return {"value": call()}
    except Exception as error: return {"error": str(error)}

Path("worker-context.json").write_text(json.dumps({
    "pid": os.getpid(), "cwd": os.getcwd(), "workspace": os.environ["RSA_WORKSPACE"],
    "pythonExecutable": sys.executable, "configuredPython": os.environ["RSA_PYTHON"],
    "runId": os.environ["RSA_RUN_ID"], "epoch": os.environ["BASEWARE_EPOCH"],
    "rsaSocket": os.environ["RSA_SOCKET"], "basewareSocket": os.environ["BASEWARE_SOCKET"],
    "trace": json.loads(os.environ["BASEWARE_TRACE"]),
    "staleRsaEpoch": os.environ.get("RSA_EPOCH"), "staleRsaTrace": os.environ.get("RSA_TRACE")
}))
print("WORKER_READY", flush=True)
previous = None
while True:
    phase = Path("phase").read_text().strip()
    if phase != previous:
        result = {"phase": phase, "pid": os.getpid(), "rsa": attempt(lambda: act(phase))}
        result["baseware"] = attempt(lambda: Device().controller("pad.echo", {"label": phase}))
        cli = subprocess.run(["rsa", "controller", "controller/pad.echo", "--args", json.dumps({"label": phase})], text=True, capture_output=True)
        result["cli"] = {"exitCode": cli.returncode, "stdout": cli.stdout, "stderr": cli.stderr}
        Path("result-" + phase + ".json").write_text(json.dumps(result))
        print("PHASE " + phase, flush=True)
        previous = phase
    time.sleep(0.02)
`;

test("native service survives OMP turns while human handback revokes its original RSA/Baseware epoch", async () => {
  const f = await fixture();
  let pid: number | undefined;
  try {
    await writeFile(join(f.workspace, "worker.py"), worker);
    await writeFile(join(f.workspace, "phase"), "first");
    const firstEpoch = f.epoch();
    await f.prompt(tool("launch-service", "bash", { command: '"$RSA_PYTHON" -u worker.py', name: "offline-controller",
      pty: false, ready: { log: "WORKER_READY", timeout: 10 } }));
    const injectedPaths = { path: process.env.PATH, python: process.env.PYTHONPATH };
    expect(f.results.get("launch-service")?.details.service).toMatchObject({ name: "offline-controller", ready: true });
    await until(() => Bun.file(join(f.workspace, "result-first.json")).exists());
    const context = await Bun.file(join(f.workspace, "worker-context.json")).json();
    pid = context.pid;
    expect(context.configuredPython).toBe(pythonExecutable());
    if (isAbsolute(pythonExecutable())) expect(dirname(context.pythonExecutable)).toBe(dirname(pythonExecutable()));
    expect(context).toMatchObject({ cwd: f.workspace, workspace: f.workspace, runId: "native-bash-run",
      epoch: firstEpoch, rsaSocket: f.rsaSocket, basewareSocket: f.basewareSocket,
      staleRsaEpoch: "", staleRsaTrace: "" });
    expect(await Bun.file(join(f.workspace, "result-first.json")).json()).toMatchObject({
      rsa: { value: { exitCode: 0 } }, baseware: { value: { exitCode: 0 } }, cli: { exitCode: 0 },
    });

    // A second native agent loop sees the same process and starts a long device action.
    await f.prompt(tool("list-service", "read", { path: "proc://" }),
      tool("read-service", "read", { path: "proc://offline-controller" }),
      tool("hold-service", "write", { path: "phase", content: "hold" }));
    expect({ path: process.env.PATH, python: process.env.PYTHONPATH }).toEqual(injectedPaths);
    expect(f.results.get("list-service")?.content[0].text).toContain("offline-controller");
    expect(f.results.get("read-service")?.content[0].text).toContain("PHASE first");
    expect(alive(pid!)).toBe(true);
    await until(f.held);
    await f.runtime.stop("human");
    await f.session.abort();
    expect(f.runtime.status()).toMatchObject({ mode: "manual", reason: "human" });
    expect(f.core.status().mode).toBe("manual");
    expect(f.held()).toBe(false);
    expect(f.cancelled()).toBe(1);
    expect(f.released()).toBe(1);
    await until(() => Bun.file(join(f.workspace, "result-hold.json")).exists());
    const heldResult = await Bun.file(join(f.workspace, "result-hold.json")).json();
    expect(heldResult).toMatchObject({
      pid,
      baseware: { error: expect.stringContaining("STALE_EPOCH") },
      cli: { exitCode: 1, stderr: expect.stringContaining("STALE_EPOCH") },
    });
    expect(heldResult.rsa).toHaveProperty("error");
    expect(heldResult.rsa).not.toHaveProperty("value");
    expect(alive(pid!)).toBe(true);

    // Fresh foreground work gets the new lease; the resident process cannot inherit it.
    await f.nextEpoch();
    await f.prompt(tool("old-service-next-epoch", "write", { path: "phase", content: "next" }),
      tool("new-foreground", "bash", { command: 'python3 -c \'from rsa_tools import Client; print(Client().call("controller/pad.echo", {"label": "fresh"})["exitCode"])\'' }));
    expect({ path: process.env.PATH, python: process.env.PYTHONPATH }).toEqual(injectedPaths);
    await until(() => Bun.file(join(f.workspace, "result-next.json")).exists());
    expect(await Bun.file(join(f.workspace, "result-next.json")).json()).toMatchObject({
      pid, rsa: { error: expect.stringContaining("STALE_EPOCH") }, baseware: { error: expect.stringContaining("STALE_EPOCH") },
      cli: { exitCode: 1, stderr: expect.stringContaining("STALE_EPOCH") },
    });
    expect(f.actions).toEqual([
      { args: {label: "first"}, epoch: firstEpoch }, { args: {label: "first"}, epoch: firstEpoch },
      { args: {label: "first"}, epoch: firstEpoch }, { args: {label: "hold"}, epoch: firstEpoch },
      { args: {label: "fresh"}, epoch: f.epoch() },
    ]);
    await f.prompt(tool("stop-service", "write", { path: "proc://offline-controller/kill" }));
    await until(() => !alive(pid!));
    for (const names of f.toolsSeen) expect(names).toEqual(f.baseTools.toSorted());

    const events = await f.events();
    const start = events.find(event => event.type === "shiori_span_start"
      && event.data.operation === "execute_tool" && event.trace.toolCallId === "launch-service");
    expect(start).toBeDefined();
    expect(context.trace).toEqual({ epoch: firstEpoch, recordingId: "native-bash-run" });
    const calls = events.filter(event => event.type === "python_call_start");
    expect(calls).toHaveLength(3);
    // Shell context identifies the run and lease, not a guessed tool parent.
    // Python creates its own trace root; actual nested calls keep that root.
    for (const event of calls) {
      expect(event.runId).toBe("native-bash-run");
      expect(event.trace.epoch).toBe(firstEpoch);
      expect(event.trace.traceId).toBeString();
      expect(event.trace.parentSpanId).toBeUndefined();
      expect(event.trace.toolCallId).toBeUndefined();
    }
    const late = events.find(event => event.type === "python_call_end" && event.data.outcome === "error");
    expect(late.trace.epoch).toBe(firstEpoch);
    const driverCall = events.find(event => event.type === "capability_start"
      && event.data.id === "controller/pad.echo" && event.trace.parentSpanId === calls[0]!.trace.spanId);
    expect(driverCall).toBeDefined();
    const device = events.find(event => event.type === "execution" && event.trace.parentSpanId === driverCall.trace.spanId);
    expect(device.trace).toMatchObject({ traceId: calls[0]!.trace.traceId, epoch: firstEpoch });
    expect(device.trace.toolCallId).toBeUndefined();
    expect(events.some(event => event.type === "exec" || event.type === "exec_result")).toBe(false);
  } finally {
    await f.close();
    if (pid) await until(() => !alive(pid!));
  }
}, 45_000);

test("native async bash job remains readable across prompts and proc kill cancels its process", async () => {
  const f = await fixture();
  let pid: number | undefined;
  try {
    await writeFile(join(f.workspace, "job.py"),
      'import os, time\nfrom pathlib import Path\nPath("job.pid").write_text(str(os.getpid()))\nprint("ASYNC_READY", flush=True)\nwhile True: time.sleep(0.05)\n');
    await f.prompt(tool("launch-job", "bash", { command: "python3 -u job.py", async: true, timeout: 0 }));
    await until(() => Bun.file(join(f.workspace, "job.pid")).exists());
    pid = Number(await Bun.file(join(f.workspace, "job.pid")).text());
    const jobs = f.session.asyncJobManager!.getAllJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.status).toBe("running");
    await f.prompt(tool("read-job", "read", { path: `proc://${job.id}` }));
    expect(f.results.get("read-job")?.content[0].text).toContain("running");
    expect(alive(pid)).toBe(true);
    await f.prompt(tool("cancel-job", "write", { path: `proc://${job.id}/kill` }));
    await until(() => !alive(pid!));
    expect(f.session.asyncJobManager!.getJob(job.id)?.status).toBe("cancelled");
    for (const names of f.toolsSeen) expect(names).toEqual(f.baseTools.toSorted());
  } finally {
    await f.close();
    if (pid) await until(() => !alive(pid!));
  }
}, 30_000);

test("a native background completion after handback cannot start an extra model request", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "finish.py"),
      'import time\nfrom pathlib import Path\nwhile not Path("finish").exists(): time.sleep(0.02)\nprint("FINISHED_AFTER_HANDBACK")\n');
    await f.prompt(tool("completion-job", "bash", { command: "python3 -u finish.py", async: true, timeout: 0 }));
    const requests = f.toolsSeen.length;
    const epoch = f.epoch();
    const job = f.session.asyncJobManager!.getAllJobs()[0]!;
    expect(job.status).toBe("running");
    await f.runtime.stop("human");
    await f.session.abort();
    f.clearCycle();
    await writeFile(join(f.workspace, "finish"), "");
    await job.promise;
    await f.session.settleAsyncWork();
    expect(job.status).toBe("completed");
    expect(f.toolsSeen).toHaveLength(requests);
    expect(f.runtime.status().mode).toBe("manual");
    const events = await f.events();
    const launched = events.find(event => event.type === "background_start" && event.data.jobId === job.id);
    const completed = events.find(event => event.type === "background_result" && event.data.jobId === job.id);
    expect(completed?.trace).toEqual(launched?.trace);
    expect(completed?.trace).toMatchObject({ epoch, toolCallId: "completion-job" });
    expect(completed?.data).toMatchObject({ kind: "job", status: "completed" });
  } finally { await f.close(); }
}, 30_000);

test("historical CLI images survive native bash, sibling tools and persistence without a latest-frame substitution", async () => {
  const f = await fixture();
  try {
    const image = (red: number, blue: number) => encodeRawPng(new Uint8Array(Array.from({ length: 32 * 32 }, () => [red, 0, blue]).flat()), 32, 32, 3);
    const oldPng = image(255, 0), latestPng = image(0, 255);
    await writeFile(join(f.workspace, "old.png"), oldPng);
    await writeFile(join(f.workspace, "latest.png"), latestPng);
    await writeFile(join(f.workspace, "frame"), "old");
    await writeFile(join(f.workspace, "perception.py"), `from pathlib import Path
from rsa_tools import capability, record
class Perception:
    sample_hz = 20
    def start(self, context): pass
    @record
    @capability
    def sample(self):
        frame = Path("frame").read_text()
        return {"text": frame, "media": [{"path": frame+".png", "mediaType": "image/png"}]}
    def close(self): pass
`);
    f.runtime.perception = new PerceptionRuntime({ workspace: f.workspace, runDir: f.runDir, record: f.runtime.record });
    await f.runtime.perception.reload();
    await until(() => f.runtime.perception!.status().state === "ready");
    const old = await f.runtime.perception.observe(new AbortController().signal);
    await writeFile(join(f.workspace, "frame"), "latest");
    await until(async () => (await f.runtime.perception!.observe(new AbortController().signal)).records[0]?.text === "latest");
    const decoder = new TerminalGraphicsDecoder();
    decoder.push(await encodeTerminalImage({ type: "image", data: Buffer.from(oldPng).toString("base64"), mimeType: "image/png" }));
    decoder.finish();
    const expectedImage = (await decoder.images())[0]!;
    const command = `rsa observe --at '${old.records[0]!.recordedAt}' --images`;
    // Test both sibling orders: the final plain-text result must not add a live screenshot.
    for (const reverse of [false, true]) {
      const id = `history-${reverse}`;
      const calls = [...tool(id, "bash", { command }), ...tool(`sibling-${reverse}`, "bash", { command: "sleep 0.05; printf sibling" })];
      await f.prompt(reverse ? calls.reverse() : calls);
      expect(f.results.get(id).content.filter((part: any) => part.type === "image")).toEqual([expectedImage]);
      expect(f.results.get(`sibling-${reverse}`).content.filter((part: any) => part.type === "image")).toHaveLength(0);
      const events = await f.events();
      const deliveryIds = f.deliveriesSeen.at(-1)!;
      const receipts = events.filter(event => event.type === "observation_context" && deliveryIds.includes(event.data.id));
      expect(receipts).toHaveLength(1);
      const inputIds = receipts.flatMap(event => event.data.observations);
      expect(inputIds).toHaveLength(1);
      const delivered = events.find(event => event.type === "observation" && event.data.id === inputIds[0]);
      expect(delivered.trace.toolCallId).toBe(id);
      expect(delivered.data.origin).toBe("tool_result");
      // The CLI records the actual decoder version through the timeline writer.
      // Its source record is the requested historical frame, never latest.
      expect(delivered.data.path).toBeUndefined();
      expect(delivered.data.timeline).toEqual(old.records[0]!.media[0]!.timeline);
      expect(delivered.data.recorded).toBe(true);
      const derivative = events.find(event => event.type === "observation_media"
        && event.data.observationId === old.records[0]!.media[0]!.id
        && event.data.modelMedia?.transform === "omp.terminalGraphics");
      expect(derivative?.data.modelMedia).toMatchObject({ recordId: old.records[0]!.id,
        sequence: old.records[0]!.sequence, sourceAsset: old.records[0]!.media[0]!.timeline!.asset });
      expect(delivered.data.sha256).toBe(new Bun.CryptoHasher("sha256").update(Buffer.from(expectedImage.data, "base64")).digest("hex"));
      expect(Buffer.from(old.records[0]!.media[0]!.data!, "base64")).toEqual(Buffer.from(oldPng));
      const saved = f.session.agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
      expect(saved?.role === "toolResult" && saved.content).toContainEqual(expectedImage);
      expect(JSON.stringify(saved)).toContain(old.records[0]!.recordedAt);
    }
    // Without --images the JSON remains machine-readable and the normal live
    // context continues. A CLI lookup alone is never logged as pixel delivery.
    await f.prompt(tool("json-only", "bash", { command: `rsa observe --at '${old.records[0]!.recordedAt}'` }));
    const events = await f.events();
    expect(events.some(event => event.type === "observation" && event.trace.toolCallId === "json-only")).toBe(false);
    const jsonOnlyReceipts = events.filter(event => event.type === "observation_context"
      && f.deliveriesSeen.at(-1)!.includes(event.data.id));
    expect(jsonOnlyReceipts.flatMap(event => event.data.observations)).not.toContain(old.records[0]!.media[0]!.id);

    await f.prompt(tool("background-history", "bash", { command: `sleep 0.1; ${command}`, async: true, timeout: 0 }));
    const job = f.session.asyncJobManager!.getAllJobs().at(-1)!;
    await job.promise;
    await f.session.settleAsyncWork();
    const backgroundInputs = (await f.events()).filter(event => event.type === "observation" && event.data.controllerId === "background_result");
    expect(backgroundInputs).toHaveLength(1);
    expect(backgroundInputs[0].data.path).toBeUndefined();
    expect(backgroundInputs[0].data.timeline).toEqual(old.records[0]!.media[0]!.timeline);
    expect(backgroundInputs[0].data.recorded).toBe(true);
    expect(backgroundInputs[0].data.sha256).toBe(new Bun.CryptoHasher("sha256").update(Buffer.from(expectedImage.data, "base64")).digest("hex"));
    expect(backgroundInputs[0].trace.toolCallId).toBeUndefined();
  } finally { await f.close(); }
}, 30_000);
