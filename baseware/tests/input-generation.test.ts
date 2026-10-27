import { afterEach, expect, test } from "bun:test";
import { BasewareCore } from "../src/core.ts";
import { createPadPlayer } from "../src/drivers/pad.ts";
import type { Bridge } from "../src/drivers/bridge.ts";
import type { Controller, ToolExecutionResult } from "../src/contracts.ts";
import type { DeviceEvent, Trace } from "../src/protocol.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner = { id: "rsa-host" };
const epoch = "epoch-a";
const signal = () => new AbortController().signal;
const trace = (generation = "worker-a"): Trace => ({ recordingId: "run-a", epoch,
  inputGeneration: generation, recordingPurpose: "continuous-action" });
const result = (): ToolExecutionResult => ({ id: crypto.randomUUID(), status: "completed", exitCode: 0,
  stdout: "", stderr: "", result: { content: [] }, timing: { clock: "fixture", requestedAtMs: 1, receivedAtMs: 2 } });
async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(1);
  }
}

async function fixture(options: { timeoutMs?: number; execute?: Controller["execute"]; acquire?: (n: number) => Promise<void>;
  release?: (n: number) => Promise<void>; seconds?: number } = {}) {
  let nativeOwner: string | undefined;
  let held = false, acquisitions = 0, releases = 0, reads = 0, writes = 0;
  const events: DeviceEvent[] = [];
  const motor: Controller = { tool: { name: "motor", inputSchema: { type: "object" } }, requiresControl: true,
    async acquire(value) { acquisitions++; await options.acquire?.(acquisitions); nativeOwner = value; },
    async release(value) {
      releases++;
      if (nativeOwner === value) { nativeOwner = undefined; held = false; }
      await options.release?.(releases);
    },
    async execute(args, context) {
      if (nativeOwner !== context.epoch) throw new Error("native control missing");
      writes++; held = true;
      return options.execute ? options.execute(args, context) : result();
    },
  };
  const camera: Controller = { tool: { name: "camera", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    requiresControl: false, async execute() { reads++; return result(); } };
  const core = new BasewareCore({ drivers: [], capabilities: { controllers: [motor, camera] }, inputResetTimeoutMs: options.timeoutMs,
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, ...metadata! } as DeviceEvent) });
  cleanups.push(() => core.close());
  await core.acquire(epoch, options.seconds ?? 30, owner, undefined, { recordingId: "run-a" });
  const generation = (value: string | null) => core.handle({ kind: "input_generation", epoch, generation: value }, owner);
  const input = (generation?: string) => core.execute("motor", {}, epoch, signal(), generation ? trace(generation) : {});
  const read = (generation?: string) => core.execute("camera", {}, generation ? epoch : undefined, signal(), generation ? trace(generation) : {});
  return { core, events, generation, input, read, state: () => ({ nativeOwner, held, acquisitions, releases, reads, writes }) };
}

test("only the owner installs generation; same-epoch stale workers cannot read or write", async () => {
  const f = await fixture();
  await expect(f.core.handle({ kind: "input_generation", epoch, generation: "worker-a" }, { id: "shell" }))
    .rejects.toThrow("Only the control owner");
  await expect(f.core.handle({ kind: "input_generation", epoch }, owner)).rejects.toThrow("requires generation");
  await f.generation("worker-a");
  expect(f.state()).toMatchObject({ acquisitions: 1, releases: 0 });
  await f.input("worker-a");
  expect(f.state().held).toBe(true);
  await f.generation("worker-b");
  expect(f.core.status()).toMatchObject({ mode: "auto", epoch, inputGeneration: "worker-b", inputResetting: false });
  expect(f.state()).toMatchObject({ held: false, acquisitions: 2, releases: 1 });
  await expect(f.input("worker-a")).rejects.toThrow("STALE_INPUT_GENERATION");
  await expect(f.read("worker-a")).rejects.toThrow("STALE_INPUT_GENERATION");
  await f.read();
  await f.input("worker-b");
  await f.generation(null);
  expect(f.state()).toMatchObject({ held: false, acquisitions: 3, releases: 2 });
  await expect(f.input("worker-b")).rejects.toThrow("STALE_INPUT_GENERATION");
  await f.input(); // Ordinary CLI remains usable in this exact parent epoch.
  expect(f.core.status()).toMatchObject({ mode: "auto", epoch, inputGeneration: null });
});

test("reset clears held input and drains admitted CLI writes while unscoped sensing continues", async () => {
  const done = Promise.withResolvers<ToolExecutionResult>();
  let oldSignal: AbortSignal | undefined;
  const f = await fixture({ execute: async (_, { signal }) => { oldSignal = signal; return done.promise; } });
  await f.generation("worker-a");
  const pending = f.input(); // This RPC deliberately ignores abort, like a native transport may.
  await until(() => !!oldSignal);
  const reset = f.generation("worker-b");
  expect(oldSignal!.aborted).toBe(true);
  expect(f.state().held).toBe(false);
  expect(f.core.status().inputResetting).toBe(true);
  await expect(f.input()).rejects.toThrow("BUSY");
  await expect(f.input("worker-a")).rejects.toThrow("STALE_INPUT_GENERATION");
  await f.read();
  expect(f.state()).toMatchObject({ acquisitions: 1, reads: 1 });
  done.resolve(result());
  await pending;
  await reset;
  expect(f.state()).toMatchObject({ acquisitions: 2, releases: 1, held: false });
  expect(f.core.status()).toMatchObject({ mode: "auto", epoch, inputGeneration: "worker-b" });
});

test("asynchronous play survives its submit RPC but is cancelled by generation reset", async () => {
  let nativeOwner: string | undefined, held = false;
  const pending = Promise.withResolvers<string[]>();
  const events: DeviceEvent[] = [];
  const bridge = { request: async (command: string) => {
    if (command === "APPLY") { held = true; return pending.promise; }
    if (command === "STOP") { held = false; pending.resolve(["interrupted"]); return []; }
    throw new Error(command);
  } } as unknown as Bridge;
  const player = createPadPlayer({ bridge, clock: { id: "native", now: performance.now.bind(performance) },
    encode: () => "long held combination", decode: () => ({}) });
  const controller: Controller = { tool: { name: "pad", inputSchema: { type: "object" } }, requiresControl: true,
    async acquire(value) { player.reset(); nativeOwner = value; },
    async release(value) {
      if (nativeOwner !== value) return;
      nativeOwner = undefined;
      await bridge.request("STOP", [value]);
      await player.settle();
    },
    execute: (_, context) => player.execute("play", { inputs: [], wait: false }, context),
  };
  const core = new BasewareCore({ drivers: [], capabilities: { controllers: [controller] },
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, ...metadata! } as DeviceEvent) });
  cleanups.push(() => core.close());
  await core.acquire(epoch, 30, owner);
  await core.setInputGeneration(epoch, "worker-a", owner);
  const started = await core.execute("pad", {}, epoch, signal(), trace());
  expect(started.actionId).toBeString();
  expect(held).toBe(true);
  expect(events.filter(event => event.type === "action_end")).toHaveLength(0);
  await core.setInputGeneration(epoch, null, owner);
  expect(held).toBe(false);
  expect(events.filter(event => event.type === "action_end")).toHaveLength(1);
  expect(events.find(event => event.type === "action_end")).toMatchObject({ trace: { epoch, inputGeneration: "worker-a" },
    data: { status: "interrupted", actionId: started.actionId } });
  expect(core.status()).toMatchObject({ mode: "auto", epoch });
});

test("human handback during reset release never reacquires native input", async () => {
  const released = Promise.withResolvers<void>();
  const f = await fixture({ release: async n => { if (n === 1) await released.promise; } });
  await f.generation("worker-a");
  await f.input("worker-a");
  const reset = f.generation("worker-b");
  const rejected = reset.then(() => undefined, error => error);
  await until(() => f.state().releases === 1);
  const release = f.core.release(epoch, "human");
  released.resolve();
  expect(String(await rejected)).toContain("revoked");
  await release;
  expect(f.core.status()).toMatchObject({ mode: "manual", inputGeneration: null, connected: true });
  expect(f.state()).toMatchObject({ nativeOwner: undefined, held: false, acquisitions: 1 });
});

test("a native reacquisition completing after handback is released before another epoch", async () => {
  const acquire = Promise.withResolvers<void>();
  const f = await fixture({ acquire: async n => { if (n === 2) await acquire.promise; } });
  await f.generation("worker-a");
  const reset = f.generation("worker-b");
  const rejected = reset.then(() => undefined, error => error);
  await until(() => f.state().acquisitions === 2);
  const release = f.core.release(epoch, "human");
  acquire.resolve();
  expect(String(await rejected)).toContain("revoked");
  await release;
  expect(f.state().nativeOwner).toBeUndefined();
  expect(f.core.status()).toMatchObject({ mode: "manual", connected: true, inputGeneration: null });
  await f.core.acquire("epoch-b", 30, owner);
  await expect(f.input("worker-a")).rejects.toThrow();
  expect(f.state().nativeOwner).toBe("epoch-b");
});

test("timed-out input drain fails closed and cannot resume after a late completion", async () => {
  const done = Promise.withResolvers<ToolExecutionResult>();
  const f = await fixture({ timeoutMs: 20, execute: () => done.promise });
  await f.generation("worker-a");
  const pending = f.input("worker-a");
  await until(() => f.state().writes === 1);
  await expect(f.generation("worker-b")).rejects.toThrow("timed out");
  expect(f.core.status()).toMatchObject({ mode: "manual", connected: false, inputGeneration: null });
  expect(f.state()).toMatchObject({ held: false, acquisitions: 1 });
  done.resolve(result());
  await pending;
  await expect(f.core.acquire("epoch-b", 30, owner)).rejects.toThrow("disconnected");
  expect(f.state().acquisitions).toBe(1);
});

test("reset does not extend the parent lease deadline", async () => {
  const f = await fixture({ seconds: 0.12 });
  await f.generation("worker-a");
  await Bun.sleep(80);
  await f.generation("worker-b");
  await Bun.sleep(60);
  expect(f.core.status()).toMatchObject({ mode: "manual", reason: "lease expired", inputGeneration: null });
  expect(f.state().nativeOwner).toBeUndefined();
});

test("continuous action reads keep interval logging and generation attribution at all rates", async () => {
  for (const hz of [1, 10, 30]) {
    const f = await fixture();
    await f.generation("worker-a");
    const before = f.events.length;
    for (let i = 0; i < hz * 30; i++) await f.read("worker-a");
    expect(f.events.length).toBe(before);
    await f.core.close();
    const stats = f.events.filter(event => event.type === "device_sampling_stats");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ trace: { inputGeneration: "worker-a", recordingPurpose: "continuous-action" },
      data: { controllers: [{ controllerId: "camera", calls: hz * 30 }] } });
  }
});
