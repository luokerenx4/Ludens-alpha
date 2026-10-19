import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { customToolToDefinition, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { createRsaExtension, type Cycle } from "../src/harness/omp/extension.ts";
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
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", autoObserve: [], maxRequests: 2,
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
  const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
  await Bun.write(file, Buffer.from(png, "base64"));
  const runtime = createTestRuntime({ controllers: [{
    id: "camera-q", requiresControl: false, mediaTypes: ["image/png"], help: () => "sample",
    async execute(argv, { signal }) {
      signal.throwIfAborted();
      if (argv.join() !== "sample") throw new Error("bad sensor command");
      return captureResult([{ id: "sample", controllerId: "camera-q", mediaType: "image/png", path: file,
        timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } }]);
    },
  }] }, () => {});
  const control = new AbortController();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(join(directory, "workspace"), join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", autoObserve: [], maxRequests: 1,
    cycle: () => ({ epoch: "test-epoch", signal: control.signal }),
  });
  // This is the same conversion createAgentSession applies to SDK customTools.
  const observe = customToolToDefinition(extension.tools[0]);
  const exec = customToolToDefinition(extension.tools[1]);
  const ctx = {} as ExtensionContext;
  try {
    const result = await observe.execute("capture", { controllerId: "camera-q", argv: ["sample"] }, control.signal, () => {}, ctx);
    const resized = await resizeImage({ bytes: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(result.content.find((p) => p.type === "image")).toMatchObject({ type: "image", data: resized.data, mimeType: resized.mimeType });
    expect(resized.width).toBe(200);
    expect(resized.decodeFailed).toBeUndefined();
    const executed = await exec.execute("shell", { command: "printf '%s|%s|%s|%s' \"$BASEWARE_EPOCH\" \"${RSA_EPOCH-unset}\" \"${RSA_TRACE-unset}\" \"${RSA_SOCKET-unset}\"" }, control.signal, () => {}, ctx);
    expect(executed.details).toMatchObject({ exitCode: 0, stdout: "test-epoch|unset|unset|unset" });
    control.abort();
    await expect(exec.execute("cancelled", { command: "touch should-not-exist" }, control.signal, () => {}, ctx)).rejects.toThrow();
    expect(await Bun.file(join(directory, "workspace", "should-not-exist")).exists()).toBe(false);
  } finally { await runtime.close(); await rm(directory, { recursive: true }); }
});

test("tool batches reuse the latest explicit sample per sensor and invalidate all samples after failed exec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-observe-reuse-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), {recursive: true});
  const image = join(directory, "sample.png");
  await Bun.write(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  const reads: {controllerId: string; argv: readonly string[]}[] = [];
  const contexts: {observations: string[]; reusedObservations: string[]; freshObservations: string[]}[] = [];
  let sequence = 0;
  const runtime = createTestRuntime({controllers: ["camera", "second-camera"].map(controllerId => ({
    id: controllerId, requiresControl: false, mediaTypes: ["image/png"], help: () => "sample",
    async execute(argv: readonly string[]) {
      reads.push({controllerId, argv});
      if (argv[0] === "fail") throw new Error("offline sensor failure");
      return captureResult([{id: `${controllerId}-${++sequence}`, controllerId, mediaType: "image/png", path: image,
        timing: {clock: "test", requestedAtMs: sequence, receivedAtMs: sequence}}]);
    },
  }))}, (type, data) => { if (type === "observation_context") contexts.push(data as typeof contexts[number]); });
  const control = new AbortController();
  const extension = createRsaExtension({runtime, workspace: new Workspace(workspace, join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 3,
    autoObserve: ["camera", "second-camera"].map(controllerId => ({controllerId, argv: ["default"]})),
    cycle: () => ({epoch: "test", signal: control.signal}),
  });
  const handlers: Record<string, (event: any) => any> = {};
  await extension.factory({on(name: string, handler: (event: any) => any) { handlers[name] = handler; }} as ExtensionAPI);
  const observe = customToolToDefinition(extension.tools[0]);
  const exec = customToolToDefinition(extension.tools[1]);
  const ctx = {} as ExtensionContext;
  const begin = async (ids: string[]) => {
    await handlers.assistant_message({});
    for (const toolCallId of ids) await handlers.tool_call({toolCallId});
  };
  const result = (toolCallId: string, toolName: string, value: Awaited<ReturnType<typeof observe.execute>>) =>
    handlers.tool_result({toolCallId, toolName, input: {}, ...value});
  try {
    await begin(["wide", "detail"]);
    const wide = await observe.execute("wide", {controllerId: "camera", argv: ["wide"]}, control.signal, () => {}, ctx);
    expect(await result("wide", "observe", wide)).toBeUndefined();
    const detail = await observe.execute("detail", {controllerId: "camera", argv: ["detail"]}, control.signal, () => {}, ctx);
    const enriched = await result("detail", "observe", detail);
    expect(reads).toEqual([
      {controllerId: "camera", argv: ["wide"]}, {controllerId: "camera", argv: ["detail"]},
      {controllerId: "second-camera", argv: ["default"]},
    ]);
    expect(contexts[0]).toMatchObject({observations: ["camera-2", "second-camera-3"],
      reusedObservations: ["camera-2"], freshObservations: ["second-camera-3"]});
    expect(extension.context().observations).toEqual(["camera-2", "second-camera-3"]);
    // The explicit result already has its image; only the unobserved sensor adds one.
    expect(enriched.content.filter((part: {type: string}) => part.type === "image")).toHaveLength(2);

    await begin(["before-a", "before-b", "failed-exec"]);
    for (const [id, controllerId] of [["before-a", "camera"], ["before-b", "second-camera"]]) {
      const sample = await observe.execute(id, {controllerId, argv: ["detail"]}, control.signal, () => {}, ctx);
      await result(id, "observe", sample);
    }
    const failed = await exec.execute("failed-exec", {command: "exit 7"}, control.signal, () => {}, ctx);
    expect(failed.isError).toBe(true);
    await result("failed-exec", "exec", failed);
    expect(reads.slice(3)).toEqual([
      {controllerId: "camera", argv: ["detail"]}, {controllerId: "second-camera", argv: ["detail"]},
      {controllerId: "camera", argv: ["default"]}, {controllerId: "second-camera", argv: ["default"]},
    ]);
    expect(contexts[1]).toMatchObject({observations: ["camera-6", "second-camera-7"],
      reusedObservations: [], freshObservations: ["camera-6", "second-camera-7"]});

    await begin(["failed-observe"]);
    await expect(observe.execute("failed-observe", {controllerId: "camera", argv: ["fail"]},
      control.signal, () => {}, ctx)).rejects.toThrow("offline sensor failure");
    // OMP converts a thrown tool error to this result before calling the hook.
    await result("failed-observe", "observe", {content: [{type: "text", text: "offline sensor failure"}], details: {}, isError: true});
    expect(reads.slice(7)).toEqual([
      {controllerId: "camera", argv: ["fail"]},
      {controllerId: "camera", argv: ["default"]}, {controllerId: "second-camera", argv: ["default"]},
    ]);
    expect(contexts[2]).toMatchObject({observations: ["camera-8", "second-camera-9"],
      reusedObservations: [], freshObservations: ["camera-8", "second-camera-9"]});
  } finally { await runtime.close(); await rm(directory, {recursive: true}); }
});
