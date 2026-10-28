import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { customToolToDefinition, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { createRsaExtension, perceptionInput, type Cycle } from "../src/harness/omp/extension.ts";
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
    tool: { name: "camera-q", description: "sample", inputSchema: { type: "object" } }, requiresControl: false, mediaTypes: ["image/png"],
    async execute(args, { signal }) {
      signal.throwIfAborted();
      if (Object.keys(args).length) throw new Error("bad sensor command");
      return { ...captureResult([{ id: "sample", controllerId: "camera-q", mediaType: "image/png", path: file,
        timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } },
        { id: "tree", controllerId: "camera-q", mediaType: "application/json", path: tree,
          timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } }]), stdout: "active-window:Document" };
    },
  }] }, () => {});
  const work = join(directory, "workspace");
  if (await Bun.file(join(directory, "sample.png")).exists()) {
    await Bun.write(join(work, "perception.py"), `from rsa_tools import capability, record
class Perception:
    def start(self, context): pass
    def close(self): pass
    @record
    @capability
    def sample(self):
        return {"text": "active-window:Document", "media": [{"path": "../sample.png", "mediaType": "image/png"}, {"path": "../tree.json", "mediaType": "application/json"}]}
`);
    runtime.perception = new PerceptionRuntime({ workspace: work, runDir: join(directory, "run"), record: runtime.record });
    await runtime.perception.reload();
  for (let i = 0; i < 200 && runtime.perception.status().state === "loading"; i++) await Bun.sleep(10);
  }
  const control = new AbortController();
  const extension = createRsaExtension({ runtime, workspace: new Workspace(join(directory, "workspace"), join(directory, "skill-versions")),
    basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 1,
    cycle: () => ({ epoch: "test-epoch", signal: control.signal }),
  });
  // This is the same conversion createAgentSession applies to SDK customTools.
  const observe = customToolToDefinition(extension.tools[0]);
  const ctx = {} as ExtensionContext;
  try {
    const result = await observe.execute("capture", {}, control.signal, () => {}, ctx);
    const resized = await resizeImage({ bytes: Buffer.from(png, "base64"), mimeType: "image/png" });
    expect(result.content.find((p) => p.type === "image")).toMatchObject({ type: "image", data: resized.data, mimeType: resized.mimeType });
    expect(result.details).toMatchObject({ result: { stdout: "active-window:Document" } });
    expect(result.content).toContainEqual({ type: "text", text: '{"role":"window","title":"Document"}' });
    expect(resized.width).toBe(200);
    expect(resized.decodeFailed).toBeUndefined();
    control.abort();
    await expect(observe.execute("cancelled", {}, control.signal, () => {}, ctx)).rejects.toThrow();
  } finally { await runtime.close(); await rm(directory, { recursive: true }); }
});

test("text-only perception reaches automatic context and explicit reads are not duplicated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-text-observation-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "skills"), { recursive: true });
  let calls = 0;
  const runtime = createTestRuntime({ controllers: [{
    tool: { name: "desktop", description: "windows", inputSchema: { type: "object" } }, requiresControl: false,
    async execute() {
      return { ...captureResult([]), id: `windows-${++calls}`, stdout: JSON.stringify({ title: `Window ${calls}` }) };
    },
  }] }, () => {});
  await Bun.write(join(workspace, "perception.py"), `from rsa_tools import capability, record
class Perception:
    sample_hz = 0.01
    def start(self, context): self.count = 0
    def close(self): pass
    @record
    @capability
    def sample(self):
        self.count += 1
        return {"text": "Window " + str(self.count)}
`);
  runtime.perception = new PerceptionRuntime({ workspace, runDir: join(directory, "run"), record: runtime.record });
  await runtime.perception.reload();
  for (let i = 0; i < 200 && runtime.perception.status().state === "loading"; i++) await Bun.sleep(10);
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
    await handlers.tool_call({ toolCallId: "sibling" });
    const observe = customToolToDefinition(extension.tools[0]);
    const result = await observe.execute("explicit", {}, control.signal, () => {}, {} as ExtensionContext);
    expect(await handlers.tool_result({ toolCallId: "explicit", toolName: "observe", input: {}, ...result })).toBeUndefined();
    const enriched = await handlers.tool_result({ toolCallId: "sibling", toolName: "bash", input: {}, content: [{ type: "text", text: "done" }] });
    expect(calls).toBe(0);
    expect((result.details as PerceptionRead).snapshot?.sequence).toBe(1);
    expect((result.details as PerceptionRead).reused).toBe(true);
    expect(enriched.content.filter((part: any) => part.type === "image")).toHaveLength(0);
    expect(JSON.parse(enriched.content.at(-1).text).controllerOutputs).toBeUndefined();
    expect(JSON.stringify(enriched.content)).not.toContain("Window 1");
    expect(extension.context().executions).toEqual([(result.details as PerceptionRead).result.id]);
    expect(JSON.stringify(first)).toBe(persisted);
  } finally { await runtime.close(); await rm(directory, { recursive: true }); }
});

test("model projection keeps each record once with time, data and paging but no duplicate execution envelope", () => {
  const records: NonNullable<PerceptionRead["records"]> = [1, 2].map(sequence => ({
    snapshot: { id: `record-${sequence}`, sequence, generation: "generation", capability: "python/sensors.py:sample",
      identity: { id: "python/sensors.py:sample", codeSHA: "source-version" },
      recordedAt: `2026-10-28T00:00:0${sequence}Z`, sampledAt: `2026-10-28T00:00:0${sequence}Z`,
      sampling: { clock: "sensor", startedAtMs: sequence, finishedAtMs: sequence + 0.5 },
      sources: [{ sensor: "left" }] },
    text: `sensor-value-${sequence}`, data: { distance: sequence }, space: { frame: "room" },
    observations: [{ id: `image-${sequence}`, controllerId: "perception", mediaType: "image/png", data: "large-media-bytes",
      timing: { clock: "sensor", requestedAtMs: sequence, receivedAtMs: sequence + 0.5 },
      timeline: { asset: "video/frame.mp4", recordId: `record-${sequence}`, sequence } }],
  }));
  const read: PerceptionRead = { status: { state: "ready", generation: "generation", sampleHz: 30 },
    result: captureResult(records.flatMap(record => record.observations)), records, snapshot: records[1]!.snapshot,
    query: { start: "2026-10-28T00:00:00Z", limit: 2 }, hasMore: true, nextAfter: 2,
    availability: { persistent: true, hotSeconds: 600, earliest: { sequence: 1, recordedAt: records[0]!.snapshot.recordedAt },
      latest: { sequence: 10, recordedAt: "2026-10-28T00:00:10Z" }, expired: false } };
  const before = JSON.stringify(read);
  const projected = perceptionInput(read);
  expect(projected.records).toHaveLength(2);
  const { identity: _identity, ...snapshot } = records[0]!.snapshot;
  expect(projected.records![0]).toMatchObject({ ...snapshot,
    codeSHA: "source-version", text: "sensor-value-1", data: { distance: 1 },
    space: { frame: "room" }, media: [{ id: "image-1", mediaType: "image/png" }] });
  expect(projected).toMatchObject({ query: read.query, hasMore: true, nextAfter: 2, availability: read.availability });
  const serialized = JSON.stringify(projected);
  expect(serialized.match(/sensor-value-1/g)).toHaveLength(1);
  expect(serialized.match(/"record-1"/g)).toHaveLength(1);
  expect(serialized).not.toContain("large-media-bytes");
  expect(projected).not.toHaveProperty("result");
  expect(projected).not.toHaveProperty("snapshot");
  expect(JSON.stringify(read)).toBe(before);
  const historical = perceptionInput({ ...read, status: { state: "error", generation: "generation", error: "sampler failed" } });
  expect(historical).toMatchObject({ ok: true, perception: { state: "error", error: "sampler failed" } });
  expect(historical.records).toHaveLength(2);
  const error = perceptionInput({ status: { state: "error", generation: "generation", error: "unavailable" },
    result: { ...captureResult([]), stdout: "unavailable", stderr: "unavailable", status: "failed", exitCode: 1 }, error: "unavailable" });
  expect(JSON.stringify(error).match(/unavailable/g)).toHaveLength(1);
  expect(error.ok).toBe(false);
  const badQuery = perceptionInput({ ...read, error: "invalid query", records: [],
    result: { ...captureResult([]), exitCode: 1, status: "failed" } });
  expect(badQuery).toMatchObject({ ok: false, perception: { state: "ready" }, error: "invalid query" });
});
