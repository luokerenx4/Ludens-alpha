import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasewareCore } from "../src/core.ts";
import { BasewareClient } from "../src/client.ts";
import { listen } from "../src/server.ts";
import type { Capabilities, ExecutionResult } from "../src/contracts.ts";
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
    sensors: [{ id: "thermal", mediaTypes: ["text/plain"], help: () => "sample",
      async read(argv, signal) {
        if (argv[0] === "wait") await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return [{ id: `sample-${++sample}`, sensorId: "thermal", path: "/tmp/fake-observation.txt", mediaType: "text/plain",
          timing: { clock: "device", requestedAtMs: sample * 10, receivedAtMs: sample * 10 + 1 }, sourceSequence: sample }];
      } }],
    controllers: [{ id: "motor", help: () => "step | wait", async acquire(epoch) { owner = epoch; }, async release() { owner = undefined; },
      execute: execute ?? (async (argv, { epoch, signal }): Promise<ExecutionResult> => {
        if (owner !== epoch) throw new Error("wrong owner");
        actions++;
        if (argv[0] === "wait") await new Promise<void>(done => signal.addEventListener("abort", () => { cancelled++; done(); }, { once: true }));
        return { id: crypto.randomUUID(), status: signal.aborted ? "interrupted" : "completed", exitCode: signal.aborted ? 130 : 0,
          stdout: String(actions), stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } };
      }) }],
  };
  const core = new BasewareCore({ capabilities, drivers: [{ id: "fake", version: "1" }], record: (type, data, trace = {}) => events.push({ type, data, trace }) });
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
  expect(await f.client.request({ kind: "list" })).toMatchObject({ drivers: [{ id: "fake", version: "1" }], sensors: [{ id: "thermal", help: "sample" }] });
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const cli = Bun.spawn([process.execPath, "src/main.ts", "controller", "motor", "step"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, BASEWARE_SOCKET: f.socket, BASEWARE_EPOCH: f.epoch, BASEWARE_TRACE: JSON.stringify({ toolCallId: "cli-call" }) },
    stdout: "pipe", stderr: "pipe",
  });
  const text = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(JSON.parse(text)).toMatchObject({ status: "completed", stdout: "1" });
  expect(f.core.status().mode).toBe("auto");
  expect(f.events.find(e => e.type === "execution")?.trace.toolCallId).toBe("cli-call");
  await f.client.request({ kind: "sensor", id: "thermal", argv: ["sample"], trace: { toolCallId: "observe-call" } });
  expect(f.events.find(e => e.type === "observation")?.data).toMatchObject({ afterExecution: { toolCallId: "cli-call" } });
  await f.client.request({ kind: "release", epoch: f.epoch });
  await expect(f.client.request({ kind: "controller", id: "motor", argv: ["step"], epoch: f.epoch })).rejects.toThrow("STALE_EPOCH");
});

test("AbortSignal cancels one long call while keeping its owner's lease", async () => {
  const f = await fixture();
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const signal = new AbortController();
  const action = f.client.request({ kind: "controller", id: "motor", argv: ["wait"], epoch: f.epoch }, signal.signal);
  await until(() => f.actions() === 1);
  signal.abort();
  await expect(action).rejects.toThrow();
  await until(() => f.cancelled() === 1);
  expect(f.owner()).toBe(f.epoch);
  expect(f.core.status().mode).toBe("auto");
  expect(await f.client.request({ kind: "controller", id: "motor", argv: ["step"], epoch: f.epoch })).toMatchObject({ status: "completed" });
});

test("closing an ordinary caller cancels its operation but closing the owner restores manual control", async () => {
  const f = await fixture();
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const caller = await BasewareClient.connect(f.socket);
  const action = caller.request({ kind: "controller", id: "motor", argv: ["wait"], epoch: f.epoch });
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
  const done = Promise.withResolvers<ExecutionResult>();
  let started = false;
  const f = await fixture(async () => { started = true; return done.promise; });
  await f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  const action = f.client.request({ kind: "controller", id: "motor", epoch: f.epoch });
  await until(() => started);
  expect(await f.client.request({ kind: "revoke" })).toMatchObject({ mode: "manual" });
  expect(f.owner()).toBeUndefined();
  done.resolve({ id: "late", status: "interrupted", exitCode: 130, stdout: "", stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } });
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
  f.capabilities.controllers[0]!.acquire = async epoch => { entered = true; await gate.promise; await acquire(epoch); };
  const pending = f.client.request({ kind: "acquire", epoch: f.epoch, seconds: 30 });
  await until(() => entered);
  f.client.close();
  await expect(pending).rejects.toThrow();
  gate.resolve();
  await until(() => f.core.status().mode === "manual");
  expect(f.owner()).toBeUndefined();
});

test("duplicate capability IDs fail registration", () => {
  expect(() => new BasewareCore({ drivers: [], capabilities: { controllers: [], sensors: [
    { id: "same", mediaTypes: [], help: () => "", read: async () => [] },
    { id: "same", mediaTypes: [], help: () => "", read: async () => [] },
  ] } })).toThrow("Duplicate");
});
