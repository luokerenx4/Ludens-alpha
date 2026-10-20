import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { customToolToDefinition, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
import { PerceptionRuntime, type PerceptionRead } from "../src/harness/perception.ts";
import { captureResult, createTestRuntime } from "./runtime-fixture.ts";
import { Workspace } from "../src/harness/workspace.ts";

test("request budgets reset on a new takeover while repeated prompts share the same epoch budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-epoch-budget-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), { recursive: true });
  const requests: {epoch?: string; request: number}[] = [];
  const runtime = createTestRuntime({controllers: []}, (type, data, trace) => {
    if (type === "context") requests.push({epoch: trace?.epoch, request: (data as {request: number}).request});
  });
  let cycle: Cycle;
  runtime.agent = {
    async run(context) {
      cycle = context;
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), {once: true}));
    },
    async consolidate() {},
    async abort() {},
    async close() {},
  };
  const extension = createRsaExtension({runtime, workspace: new Workspace(workspace, join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 2,
    cycle: () => cycle,
  });
  const handlers: Record<string, (event: any) => any> = {};
  await extension.factory({on(name: string, handler: (event: any) => any) { handlers[name] = handler; }} as ExtensionAPI);
  const epochs: string[] = [];
  try {
    for (let round = 0; round < 2; round++) {
      const {epoch} = await runtime.start();
      epochs.push(epoch!);
      for (let prompt = 0; prompt < 2; prompt++) {
        await handlers.before_agent_start({});
        await handlers.context({});
      }
      expect(runtime.status()).toMatchObject({mode: "auto", epoch});
      await expect(handlers.context({})).rejects.toThrow();
      expect(runtime.status()).toMatchObject({mode: "manual", reason: "model request budget", thinking: false});
    }
    expect(epochs[0]).not.toBe(epochs[1]);
    expect(requests).toEqual(epochs.flatMap(epoch => [{epoch, request: 1}, {epoch, request: 2}]));
  } finally { await runtime.close(); await rm(directory, {recursive: true}); }
});

test("OMP's SDK adapter delivers the abort signal correctly and returns real image blocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-omp-"));
  await mkdir(join(directory, "workspace", "skills"), { recursive: true });
  const file = join(directory, "sample.png");
  const tree = join(directory, "tree.json");
  await Bun.write(tree, '{"role":"window","title":"Document"}');
  const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
  await Bun.write(file, Buffer.from(png, "base64"));
  const runtime = createTestRuntime({ controllers: [{
    id: "camera-q", requiresControl: false, mediaTypes: ["image/png"], help: () => "sample",
    async execute(argv, { signal }) {
      signal.throwIfAborted();
      if (argv.join() !== "sample") throw new Error("bad sensor command");
      return { ...captureResult([{ id: "sample", controllerId: "camera-q", mediaType: "image/png", path: file,
        timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } },
        { id: "tree", controllerId: "camera-q", mediaType: "application/json", path: tree,
          timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } }]), stdout: "active-window:Document" };
    },
  }] }, () => {});
  const work = join(directory, "workspace");
  if (await Bun.file(join(directory, "sample.png")).exists()) {
    await Bun.write(join(work, "perception.py"), `class Perception:
    def start(self, context): pass
    def close(self): pass
    def observe(self):
        return {"sequence": 1, "text": "active-window:Document", "media": [{"path": "../sample.png", "mediaType": "image/png"}, {"path": "../tree.json", "mediaType": "application/json"}]}
`);
    runtime.perception = new PerceptionRuntime({ workspace: work, runDir: join(directory, "run"), record: runtime.record });
    await runtime.perception.reload();
  }
  const control = new AbortController();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(join(directory, "workspace"), join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 1,
    cycle: () => ({ epoch: "test-epoch", signal: control.signal }),
  });
  // This is the same conversion createAgentSession applies to SDK customTools.
  const observe = customToolToDefinition(extension.tools[0]);
  const exec = customToolToDefinition(extension.tools[1]);
  const ctx = {} as ExtensionContext;
  try {
    const result = await observe.execute("capture", {}, control.signal, () => {}, ctx);
    const resized = await resizeImage({ bytes: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(result.content.find((p) => p.type === "image")).toMatchObject({ type: "image", data: resized.data, mimeType: resized.mimeType });
    expect(result.details).toMatchObject({ result: { stdout: "active-window:Document" } });
    expect(result.content).toContainEqual({ type: "text", text: '{"role":"window","title":"Document"}' });
    expect(resized.width).toBe(200);
    expect(resized.decodeFailed).toBeUndefined();
    const executed = await exec.execute("shell", { command: "printf '%s|%s|%s|%s' \"$BASEWARE_EPOCH\" \"${RSA_EPOCH-unset}\" \"${RSA_TRACE-unset}\" \"${RSA_SOCKET-unset}\"" }, control.signal, () => {}, ctx);
    expect(executed.details).toMatchObject({ exitCode: 0, stdout: "test-epoch|unset|unset|unset" });
    control.abort();
    await expect(exec.execute("cancelled", { command: "touch should-not-exist" }, control.signal, () => {}, ctx)).rejects.toThrow();
    expect(await Bun.file(join(directory, "workspace", "should-not-exist")).exists()).toBe(false);
  } finally { await runtime.close(); await rm(directory, { recursive: true }); }
});

test("text-only perception reaches automatic context and explicit reads are not duplicated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-text-observation-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), { recursive: true });
  let calls = 0;
  const runtime = createTestRuntime({ controllers: [{
    id: "desktop", requiresControl: false, help: () => "windows",
    async execute() {
      return { ...captureResult([]), id: `windows-${++calls}`, stdout: JSON.stringify({ title: `Window ${calls}` }) };
    },
  }] }, () => {});
  await Bun.write(join(workspace, "perception.py"), `class Perception:
    def start(self, context): self.count = 0
    def close(self): pass
    def observe(self):
        self.count += 1
        return {"sequence": self.count, "text": "Window " + str(self.count)}
`);
  runtime.perception = new PerceptionRuntime({ workspace, runDir: join(directory, "run"), record: runtime.record });
  await runtime.perception.reload();
  const control = new AbortController();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(directory, "versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 3,
    cycle: () => ({ epoch: "test", signal: control.signal }),
  });
  const handlers: Record<string, (event: any) => any> = {};
  await extension.factory({ on(name: string, handler: (event: any) => any) { handlers[name] = handler; } } as ExtensionAPI);
  try {
    const first = await handlers.before_agent_start({});
    const persisted = JSON.stringify(first);
    expect(persisted).toContain("Window 1");
    await handlers.assistant_message({});
    await handlers.tool_call({ toolCallId: "explicit" });
    const observe = customToolToDefinition(extension.tools[0]);
    const result = await observe.execute("explicit", {}, control.signal, () => {}, {} as ExtensionContext);
    const enriched = await handlers.tool_result({ toolCallId: "explicit", toolName: "observe", input: {}, ...result });
    expect(calls).toBe(0);
    expect(JSON.stringify(enriched).match(/Window 2/g)).toHaveLength(1);
    expect(JSON.parse(enriched.content.at(-1).text).controllerOutputs).toBeUndefined();
    expect(extension.context().executions).toEqual([(result.details as PerceptionRead).result.id]);
    expect(JSON.stringify(first)).toBe(persisted);
  } finally { await runtime.close(); await rm(directory, { recursive: true }); }
});
