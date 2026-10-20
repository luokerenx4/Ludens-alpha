import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Capabilities, Controller } from "@playness/baseware/contracts";
import { captureResult, createTestRuntime, createTestDeviceSession, readTestController } from "./runtime-fixture.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { dispatch, listen, send } from "../src/harness/transport.ts";

function fixture() {
  let angle = 0, owner: string | undefined;
  const controller: Controller = {
    id: "joint-7", requiresControl: true, help: () => "rotate <degrees>",
    async acquire(epoch) { owner = epoch; },
    async release(epoch) { if (owner === epoch) owner = undefined; },
    async execute(argv, context) {
      if (owner !== context.epoch) throw new Error("wrong owner");
      if (argv[0] !== "rotate") throw new Error("unknown operation");
      angle += Number(argv[1]);
      return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: String(angle), stderr: "",
        timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } };
    },
  };
  const capabilities: Capabilities = {
    controllers: [controller, { id: "thermal-9", requiresControl: false, mediaTypes: ["text/plain"], help: () => "sample",
      async execute(argv) {
        if (argv.join() !== "sample") throw new Error("bad sensor arguments");
        return captureResult([{ id: "temperature", controllerId: "thermal-9", mediaType: "text/plain", path: "/tmp/temperature.txt",
          timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } }]);
      },
    }],
  };
  const { core, devices } = createTestDeviceSession(capabilities);
  const runtime = new Runtime(devices, () => {});
  runtime.controller = new WorkspaceController({ workspace: process.cwd(), devices, record: () => {}, env: {} });
  return { controller, capabilities, core, devices, runtime, angle: () => angle, owner: () => owner };
}

test("takeover time remaining ignores host age and resets on each epoch", async () => {
  const { runtime } = fixture();
  const now = spyOn(performance, "now").mockReturnValue(120_000);
  try {
    expect(runtime.status().remainingSeconds).toBeNull();
    const first = await runtime.start();
    expect(first.remainingSeconds).toBe(300);
    now.mockReturnValue(240_000);
    expect(runtime.status().remainingSeconds).toBe(180);
    now.mockReturnValue(500_000);
    expect(runtime.status().remainingSeconds).toBe(0);
    await runtime.stop();
    expect(runtime.status().remainingSeconds).toBeNull();
    const second = await runtime.start();
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.remainingSeconds).toBe(300);
  } finally { now.mockRestore(); await runtime.close(); }
});

test("a human takeover message reaches only its own cycle and malformed arguments cannot acquire control", async () => {
  const { runtime, owner } = fixture();
  const messages: (string | undefined)[] = [];
  runtime.agent = {
    run: async ({ message, signal }) => {
      messages.push(message);
      await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
    },
    consolidate: async () => {}, abort: async () => {}, close: async () => {},
  };
  const runId = runtime.status().runId;
  try {
    await expect(dispatch(runtime, { kind: "auto", argv: ["on", "--message"], runId })).rejects.toThrow("Usage");
    expect(owner()).toBeUndefined();
    await dispatch(runtime, { kind: "auto", argv: ["on", "--message", "Save before shutdown."], runId, expectedEpoch: null });
    expect(messages).toEqual(["Save before shutdown."]);
    await runtime.close();
    await dispatch(runtime, { kind: "auto", argv: ["on"], runId, expectedEpoch: null });
    expect(messages).toEqual(["Save before shutdown.", undefined]);
  } finally { await runtime.close(); }
});

test("Runtime discovers non-game catalog entries and reads through its device session", async () => {
  const { runtime, devices, owner } = fixture();
  const acquire = spyOn(devices, "acquire"), release = spyOn(devices, "release");
  try {
    expect(runtime.list()).toMatchObject({ controllers: [
      { id: "joint-7", requiresControl: true, help: "rotate <degrees>" },
      { id: "thermal-9", requiresControl: false, mediaTypes: ["text/plain"], help: "sample" },
    ] });
    const result = await readTestController(runtime, "thermal-9", ["sample"], new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", observations: [{ controllerId: "thermal-9", mediaType: "text/plain" }] });
    expect(acquire).not.toHaveBeenCalled();
    const { epoch } = await runtime.start();
    expect(owner()).toBe(epoch!);
    expect(acquire).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(owner()).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(epoch);
  } finally { await runtime.close(); acquire.mockRestore(); release.mockRestore(); }
});

test("catalog help is inert and device execution receives literal argument values", async () => {
  const { runtime, core, controller, capabilities, owner } = fixture();
  const execute = spyOn(controller, "execute");
  const capture = spyOn(capabilities.controllers[1]!, "execute");
  try {
    expect(runtime.list().controllers[0]!.help).toBe("rotate <degrees>");
    expect(runtime.list().controllers[1]!.help).toBe("sample");
    expect(owner()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    await expect(readTestController(runtime, "joint-7", ["rotate", "15"], new AbortController().signal))
      .rejects.toThrow("STALE_EPOCH");
    expect(execute).not.toHaveBeenCalled();
    const { epoch } = await runtime.start();
    await expect(core.execute("joint-7", ["type", "--text", "--help"], epoch!, new AbortController().signal)).rejects.toThrow("unknown operation");
    expect(execute.mock.calls[0]![0]).toEqual(["type", "--text", "--help"]);
  } finally { await runtime.close(); execute.mockRestore(); capture.mockRestore(); }
});

test("RSA IPC requires a workspace controller and an agent environment cannot enable control through the CLI", async () => {
  const { runtime, devices } = fixture();
  runtime.controller = undefined;
  const acquire = spyOn(devices, "acquire");
  const path = `/tmp/rsa-management-${crypto.randomUUID()}.sock`;
  const close = await listen(path, runtime);
  try {
    await expect(send(path, { kind: "sensor", argv: ["any", "command"] })).rejects.toThrow("Unknown command");
    await expect(send(path, { kind: "controller", argv: [] })).rejects.toThrow("Workspace controller is unavailable");
    const cli = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), "auto", "on"], {
      env: { ...process.env, RSA_SOCKET: path, BASEWARE_EPOCH: "agent-cycle" }, stdout: "pipe", stderr: "pipe",
    });
    const errors = new Response(cli.stderr).text();
    expect(await cli.exited).toBe(1);
    expect(await errors).toContain("Control management belongs to the human");
    expect(acquire).not.toHaveBeenCalled();
    expect(runtime.status().mode).toBe("manual");
  } finally { await runtime.close(); await close(); await rm(path, { force: true }); acquire.mockRestore(); }
});

test("a blocked background read does not delay handback, the next epoch, or host close", async () => {
  const { runtime, capabilities, owner } = fixture();
  const entered = Promise.withResolvers<void>(), finishRead = Promise.withResolvers<void>();
  let finished = false, readSignal: AbortSignal | undefined;
  capabilities.controllers[1]!.execute = async (_argv, { signal }) => {
    readSignal = signal;
    entered.resolve();
    await finishRead.promise;
    finished = true;
    return captureResult([]);
  };
  const first = await runtime.start();
  const reading = readTestController(runtime, "thermal-9", ["sample"], new AbortController().signal);
  try {
    await entered.promise;
    const handedBack = await Promise.race([runtime.stop().then(() => true), Bun.sleep(100).then(() => false)]);
    expect(handedBack).toBe(true);
    expect(owner()).toBeUndefined();
    expect(finished).toBe(false);
    expect(readSignal?.aborted).toBe(false);
    const second = await runtime.start();
    expect(second.epoch).not.toBe(first.epoch);
    await runtime.close();
    expect(finished).toBe(false);
  } finally { finishRead.resolve(); await reading; await runtime.close(); }
});

test("parallel hosts route to independent devices and reject each other's epochs", async () => {
  const a = fixture(), b = fixture();
  const socketA = `/tmp/rsa-project-a-${crypto.randomUUID()}.sock`;
  const socketB = `/tmp/rsa-project-b-${crypto.randomUUID()}.sock`;
  const closeA = await listen(socketA, a.runtime), closeB = await listen(socketB, b.runtime);
  try {
    const ownerA = await a.runtime.start(), ownerB = await b.runtime.start();
    await a.core.execute("joint-7", ["rotate", "15"], ownerA.epoch!, new AbortController().signal);
    await b.core.execute("joint-7", ["rotate", "30"], ownerB.epoch!, new AbortController().signal);
    await expect(b.core.execute("joint-7", ["rotate", "100"], ownerA.epoch!, new AbortController().signal))
      .rejects.toThrow("STALE_EPOCH");
    expect([a.angle(), b.angle()]).toEqual([15, 30]);
    await expect(send(socketA, { kind: "auto", argv: ["off"], runId: b.runtime.status().runId })).rejects.toThrow("STALE_RUN");
    await expect(send(socketA, { kind: "auto", argv: ["off"], runId: a.runtime.status().runId, expectedEpoch: ownerB.epoch })).rejects.toThrow("STALE_EPOCH");
    expect(a.runtime.status()).toMatchObject({ mode: "auto", maxSeconds: 300 });
    await send(socketA, { kind: "auto", argv: ["off"], runId: a.runtime.status().runId, expectedEpoch: ownerA.epoch });
    expect(a.runtime.status().mode).toBe("manual");
    expect(b.runtime.status().mode).toBe("auto");
    await b.core.execute("joint-7", ["rotate", "5"], ownerB.epoch!, new AbortController().signal);
    expect([a.angle(), b.angle()]).toEqual([15, 35]);
  } finally { await a.runtime.close(); await b.runtime.close(); await closeA(); await closeB(); }
});

test("off completes device handback without waiting for the model, and prevents overlapping cycles", async () => {
  const { runtime, owner } = fixture();
  const model = Promise.withResolvers<void>();
  runtime.agent = { run: async () => model.promise, consolidate: async () => {}, abort: async () => {}, close: async () => {} };
  await runtime.start();
  await runtime.stop();
  expect(owner()).toBeUndefined();
  expect(runtime.status()).toMatchObject({ mode: "manual", thinking: true });
  await expect(runtime.start()).rejects.toThrow("Previous control cycle");
  model.resolve();
  await runtime.close();
});

test("consolidation keeps devices manual, rejects overlap, and drains cancellation before admitting another task", async () => {
  const { runtime, controller, capabilities, owner } = fixture();
  let deviceCalls = 0;
  controller.acquire = controller.release = async () => { deviceCalls++; };
  capabilities.controllers[1]!.execute = async () => { deviceCalls++; return captureResult([]); };
  const prompt = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  runtime.agent = {
    run: async () => {},
    consolidate: async (context) => { signal = context.signal; await prompt.promise; },
    abort: async () => { prompt.resolve(); await cleanup.promise; }, close: async () => {},
  };
  const request = { kind: "consolidate", argv: [], runId: runtime.status().runId, expectedEpoch: null };
  await expect(dispatch(runtime, { ...request, epoch: "agent" })).rejects.toThrow("human");
  await expect(dispatch(runtime, { ...request, runId: "stale" })).rejects.toThrow("STALE_RUN");
  await expect(dispatch(runtime, { ...request, argv: ["--seconds", "NaN"] })).rejects.toThrow("--seconds");
  await dispatch(runtime, request);
  expect(runtime.status()).toMatchObject({ mode: "manual", thinking: true, consolidating: true, epoch: null });
  expect(owner()).toBeUndefined();
  expect(deviceCalls).toBe(0);
  await expect(runtime.start()).rejects.toThrow("Previous control cycle");
  await expect(runtime.consolidate()).rejects.toThrow("Previous control cycle");
  await runtime.stop();
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(runtime.status().thinking).toBe(true);
  await expect(runtime.start()).rejects.toThrow("Previous control cycle");
  cleanup.resolve();
  await runtime.close();
  expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, consolidating: false });
  expect(deviceCalls).toBe(0);
});

test("consolidation reports completion, failure, and time budget cancellation separately", async () => {
  for (const expected of ["completed", "failed", "aborted"]) {
    const events: { type: string; data: any }[] = [];
    const done = Promise.withResolvers<void>();
    const runtime = createTestRuntime({ controllers: [] }, (type, data) => {
      events.push({ type, data });
      if (type === "consolidation_end") done.resolve();
    });
    const prompt = Promise.withResolvers<void>();
    runtime.agent = {
      run: async () => {},
      consolidate: async () => {
        if (expected === "failed") throw new Error("model error");
        if (expected === "aborted") await prompt.promise;
      },
      abort: async () => { prompt.resolve(); }, close: async () => {},
    };
    await runtime.consolidate(expected === "aborted" ? 0.005 : 60);
    await done.promise;
    expect(events.find(e => e.type === "consolidation_end")?.data.outcome).toBe(expected);
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, consolidating: false });
    await runtime.close();
  }
});

test("off during acquisition revokes ownership as soon as the provider grants it", async () => {
  const { runtime, controller, owner } = fixture();
  const barrier = Promise.withResolvers<void>();
  const acquire = controller.acquire;
  controller.acquire = async (epoch) => { await barrier.promise; await acquire!(epoch); };
  const start = runtime.start();
  const stop = runtime.stop();
  barrier.resolve();
  await Promise.all([start, stop]);
  expect(runtime.status().mode).toBe("manual");
  expect(owner()).toBeUndefined();
  await runtime.close();
});
