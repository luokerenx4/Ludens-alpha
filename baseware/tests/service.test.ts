import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasewareCore } from "../src/core.ts";
import { BasewareClient } from "../src/client.ts";
import { EventLog } from "../src/events.ts";
import { listen } from "../src/server.ts";
import type { Capabilities, ExecutionResult, ToolExecutionResult } from "../src/contracts.ts";
import type { DeviceEvent } from "../src/protocol.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(1);
  }
}

async function fixture(execute?: Capabilities["controllers"][number]["execute"]) {
  let owner: string | undefined;
  let actions = 0, cancelled = 0, sample = 0;
  const events: DeviceEvent[] = [];
  const capabilities: Capabilities = {
    controllers: [{ tool: { name: "motor", inputSchema: { type: "object", properties: { wait: { type: "boolean" } }, additionalProperties: false } }, requiresControl: true, async acquire(epoch) { owner = epoch; }, async release() { owner = undefined; },
      execute: execute ?? (async (args, { epoch, signal }): Promise<ToolExecutionResult> => {
        if (owner !== epoch) throw new Error("wrong owner");
        actions++;
        if (args.wait) await new Promise<void>(done => signal.addEventListener("abort", () => { cancelled++; done(); }, { once: true }));
        return { result: { content: [] }, id: crypto.randomUUID(), status: signal.aborted ? "interrupted" : "completed", exitCode: signal.aborted ? 130 : 0,
          stdout: String(actions), stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } };
      }) }, { tool: { name: "thermal", description: "sample", inputSchema: { type: "object", properties: { wait: { type: "boolean" } }, additionalProperties: false } }, requiresControl: false, mediaTypes: ["text/plain"],
      async execute(args, { signal }) {
        if (args.wait) await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        const id = `sample-${++sample}`;
        const timing = { clock: "device", requestedAtMs: sample * 10, receivedAtMs: sample * 10 + 1 };
        return { result: { content: [] }, id: `capture-${sample}`, status: "completed", exitCode: 0, stdout: "", stderr: "", timing,
          observations: [{ id, controllerId: "thermal", path: "/tmp/fake-observation.txt", mediaType: "text/plain", timing, sourceSequence: sample }] };
      } }],
  };
  const core = new BasewareCore({ capabilities, drivers: [{ id: "fake", version: "1" }],
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, source: metadata!.source!, origin: metadata!.origin! }) });
  const directory = await mkdtemp(join(tmpdir(), "baseware-test-"));
  const socket = join(directory, "service.sock");
  const close = await listen(socket, core);
  cleanup.push(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const client = await BasewareClient.connect(socket);
  const epoch = crypto.randomUUID();
  return { core, socket, client, epoch, events, capabilities, owner: () => owner, actions: () => actions, cancelled: () => cancelled };
}

test("client API and CLI use the same catalog, epoch checks and device journal", async () => {
  const f = await fixture();
  expect(await f.client.request({ kind: "list" })).toMatchObject({ drivers: [{ id: "fake", version: "1" }], controllers: [{ name: "motor", requiresControl: true }, { name: "thermal", requiresControl: false, description: "sample" }] });
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const cli = Bun.spawn([process.execPath, "src/main.ts", "controller", "motor", "--args", "{}"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, BASEWARE_SOCKET: f.socket, BASEWARE_EPOCH: f.epoch, BASEWARE_TRACE: JSON.stringify({ toolCallId: "cli-call" }) },
    stdout: "pipe", stderr: "pipe",
  });
  const text = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(JSON.parse(text)).toMatchObject({ status: "completed", stdout: "1" });
  // Explicit JSON null must not become an empty argument object on the wire.
  await expect(f.client.request({ kind: "controller", id: "motor", arguments: JSON.parse("null"), epoch: f.epoch })).rejects.toThrow("JSON object");
  expect(f.actions()).toBe(1);
  expect(f.core.status().mode).toBe("auto");
  expect(f.events.find(e => e.type === "execution")?.trace.toolCallId).toBe("cli-call");
  await f.client.request({ kind: "controller", id: "thermal", arguments: {}, trace: { toolCallId: "observe-call" } });
  expect(f.events.find(e => e.type === "observation")?.data).toMatchObject({ afterExecution: { toolCallId: "cli-call" } });
  await f.client.request({ kind: "release", epoch: f.epoch });
  await expect(f.client.request({ kind: "controller", id: "motor", arguments: {}, epoch: f.epoch })).rejects.toThrow("STALE_EPOCH");
});

test("sensing uses the same controller call without a lease and preserves the last action", async () => {
  const f = await fixture();
  const sample = () => f.client.request({ kind: "controller", id: "thermal", arguments: {} }) as Promise<ExecutionResult>;
  const first = await sample();
  expect(first).toMatchObject({ status: "completed", observations: [{ controllerId: "thermal", sourceSequence: 1 }] });
  expect(f.core.status().mode).toBe("manual");
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  await f.client.request({ kind: "controller", id: "motor", arguments: {}, epoch: f.epoch, trace: { toolCallId: "action" } });
  await sample();
  await sample();
  const observations = f.events.filter(e => e.type === "observation");
  expect(observations.slice(1).map(e => (e.data as any).afterExecution.toolCallId)).toEqual(["action", "action"]);
  expect(observations[2]!.data).toMatchObject({ previousObservationId: "sample-2", sourceSequenceDelta: 1 });
  const events = f.events.filter(e => e.trace.spanId === observations[2]!.trace.spanId);
  expect(events.map(e => e.type)).toEqual(["command", "observation_start", "execution", "observation", "observation_end"]);
  expect(events.find(e => e.type === "execution")!.data).toMatchObject({ controllerId: "thermal", requiresControl: false });
  await f.client.request({ kind: "revoke" });
  const result = await sample();
  expect(result.observations![0]!.sourceSequence).toBe(4);
});

test("AbortSignal cancels one long call while keeping its owner's lease", async () => {
  const f = await fixture();
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const signal = new AbortController();
  const action = f.client.request({ kind: "controller", id: "motor", arguments: { wait: true }, epoch: f.epoch }, signal.signal);
  await until(() => f.actions() === 1);
  signal.abort();
  await expect(action).rejects.toThrow();
  await until(() => f.cancelled() === 1);
  expect(f.owner()).toBe(f.epoch);
  expect(f.core.status().mode).toBe("auto");
  expect(await f.client.request({ kind: "controller", id: "motor", arguments: {}, epoch: f.epoch })).toMatchObject({ status: "completed" });
});

test("closing an ordinary caller cancels its operation but closing the owner restores manual control", async () => {
  const f = await fixture();
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const caller = await BasewareClient.connect(f.socket);
  const action = caller.request({ kind: "controller", id: "motor", arguments: { wait: true }, epoch: f.epoch });
  await until(() => f.actions() === 1);
  caller.close();
  await expect(action).rejects.toThrow("disconnected");
  await until(() => f.cancelled() === 1);
  expect(f.owner()).toBe(f.epoch);
  f.client.close();
  await until(() => f.core.status().mode === "manual");
  expect(f.owner()).toBeUndefined();
  expect(f.core.status().reason).toBe("owner disconnected");
});

test("human revoke releases devices without waiting for an uncooperative action", async () => {
  const done = Promise.withResolvers<ToolExecutionResult>();
  let started = false;
  const f = await fixture(async () => { started = true; return done.promise; });
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const action = f.client.request({ kind: "controller", id: "motor", epoch: f.epoch });
  await until(() => started);
  expect(await f.client.request({ kind: "revoke" })).toMatchObject({ mode: "manual" });
  expect(f.owner()).toBeUndefined();
  done.resolve({ result: { content: [] }, id: "late", status: "interrupted", exitCode: 130, stdout: "", stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } });
  expect(await action).toMatchObject({ status: "interrupted" });
});

test("lease deadline and provider disconnect are enforced without an agent", async () => {
  const f = await fixture();
  const received: DeviceEvent[] = [];
  const watcher = await BasewareClient.connect(f.socket, { onEvent: event => received.push(event) });
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 0.015 });
  await until(() => f.core.status().mode === "manual");
  expect(f.owner()).toBeUndefined();
  expect(f.core.status().reason).toBe("lease expired");
  await f.client.request({ kind: "acquire", epoch: crypto.randomUUID(), seconds: 30 });
  await f.core.disconnected(new Error("fixture disconnected"));
  await until(() => received.some(e => e.type === "baseware_disconnected"));
  expect(f.core.status()).toMatchObject({ mode: "manual", connected: false });
  expect(f.owner()).toBeUndefined();
  watcher.close();
});

test("owner disconnect during acquisition releases a late acquisition", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const acquire = f.capabilities.controllers[0]!.acquire;
  let entered = false;
  f.capabilities.controllers[0]!.acquire = async epoch => { entered = true; await gate.promise; await acquire!(epoch); };
  const pending = f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  await until(() => entered);
  f.client.close();
  await expect(pending).rejects.toThrow();
  gate.resolve();
  await until(() => f.core.status().mode === "manual");
  expect(f.owner()).toBeUndefined();
});

test("duplicate capability IDs fail registration", () => {
  const controller = { tool: { name: "same", inputSchema: { type: "object" as const } }, requiresControl: false, execute: async (): Promise<ToolExecutionResult> => {
    throw new Error("unused");
  } };
  expect(() => new BasewareCore({ drivers: [], capabilities: { controllers: [controller, controller] } })).toThrow("Duplicate");
});

test("service journal and subscribers share each fact's original identity and clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-journal-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const log = new EventLog(directory);
  const core = new BasewareCore({ capabilities: { controllers: [] }, drivers: [], record: log.record });
  const received: DeviceEvent[] = [];
  await core.handle({ kind: "subscribe" }, { id: "subscriber", onEvent: event => received.push(event) });
  core.record("service_start", {});
  await core.acquire("lease", 30, { id: "owner" });
  await core.close();
  core.record("service_end", core.status());
  const stored = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(stored).toHaveLength(4);
  for (const [index, event] of received.entries()) {
    expect(event.origin).toEqual(stored[index].origin);
    expect(event.source).toEqual({ component: "baseware", implementation: "baseware" });
    expect(stored[index]).toMatchObject({ schemaVersion: 2, serviceId: core.serviceId, seq: index + 1,
      at: event.origin.at, atMs: event.origin.atMs,
      origin: { eventId: `${core.serviceId}:${index + 1}`, clockId: core.serviceId } });
  }
});

test("device operations have distinct child spans and terminal events for success, failure and cancellation", async () => {
  const f = await fixture();
  const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16), toolCallId: "parent-tool" };
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  await f.client.request({ kind: "controller", id: "motor", arguments: {}, epoch: f.epoch, trace: parent });
  await f.client.request({ kind: "controller", id: "thermal", trace: parent });
  await expect(f.client.request({ kind: "controller", id: "motor", epoch: "stale", trace: parent })).rejects.toThrow("STALE_EPOCH");
  await expect(f.client.request({ kind: "controller", id: "absent", trace: parent })).rejects.toThrow("Unknown controller");
  const abort = new AbortController();
  abort.abort();
  await expect(f.core.execute("thermal", {}, undefined, abort.signal, parent)).rejects.toThrow();
  const starts = f.events.filter(event => event.type === "command");
  expect(starts).toHaveLength(5);
  expect(new Set(starts.map(event => event.trace.spanId)).size).toBe(5);
  const outcomes = ["success", "success", "error", "error", "cancelled"];
  for (const [index, event] of starts.entries()) {
    expect(event.trace).toMatchObject({ traceId: parent.traceId, parentSpanId: parent.spanId, toolCallId: parent.toolCallId });
    expect(event.trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    const terminals = f.events.filter(candidate => candidate.trace.spanId === event.trace.spanId
      && ["execution", "execution_error"].includes(candidate.type));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.trace).toEqual(event.trace);
    expect(terminals[0]!.data).toMatchObject({ outcome: outcomes[index] });
  }
  await expect(f.client.request({ kind: "controller" })).rejects.toThrow("Missing controller ID");
  const rejected = f.events.at(-1)!;
  expect(rejected.type).toBe("request_error");
  expect(rejected.trace.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(rejected.trace.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(rejected.data).toMatchObject({ outcome: "error" });
});

test("native media stays in RPC while event subscribers and journal receive file references", async () => {
  const native = { content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png", _meta: { frame: 7 } }],
    structuredContent: { sequence: 7 }, _meta: { source: "native" } };
  const f = await fixture(async () => ({ result: native, id: "media", status: "completed", exitCode: 0, stdout: "", stderr: "",
    timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 }, observations: [{ id: "frame", controllerId: "motor", path: "/tmp/frame.png",
      mediaType: "image/png", contentIndex: 0, timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } }] }));
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const returned = await f.client.request({ kind: "controller", id: "motor", arguments: {}, epoch: f.epoch }) as ToolExecutionResult;
  expect(returned.result).toEqual(native);
  const logged = (f.events.find(e => e.type === "execution")!.data as any).result;
  expect(logged).toMatchObject({ structuredContent: { sequence: 7 }, _meta: { source: "native" }, content: [{ dataPath: "/tmp/frame.png", _meta: { frame: 7 } }] });
  expect(logged.content[0].data).toBeUndefined();
  expect(native.content[0].data).toBe("AAAA");
  await expect(f.client.request({ kind: "controller", id: "motor", arguments: { wait: "false" }, epoch: f.epoch })).rejects.toThrow("Invalid arguments");
});
