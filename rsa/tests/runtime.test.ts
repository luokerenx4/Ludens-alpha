import { expect, spyOn, test } from "bun:test";
import type { Capabilities, Controller } from "../src/contracts.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { dispatch, listen, send } from "../src/harness/transport.ts";

function fixture() {
  let angle = 0, owner: string | undefined;
  const controller: Controller = {
    id: "joint-7", help: () => "rotate <degrees>",
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
    controllers: [controller], sensors: [{ id: "thermal-9", mediaTypes: ["text/plain"], help: () => "sample",
      async read(argv) {
        if (argv.join() !== "sample") throw new Error("bad sensor arguments");
        return [{ id: "temperature", sensorId: "thermal-9", mediaType: "text/plain", path: "/tmp/temperature.txt",
          timing: { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } }];
      },
    }],
  };
  return { controller, runtime: new Runtime(capabilities, () => {}), angle: () => angle, owner: () => owner };
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
  runtime.driver = {
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

test("the same IPC host accepts non-game capability IDs and commands, then rejects a revoked owner", async () => {
  const { runtime, owner } = fixture();
  const path = `/tmp/rsa-test-${crypto.randomUUID()}.sock`;
  const close = await listen(path, runtime);
  try {
    expect(await send(path, { kind: "controller", id: "joint-7", argv: ["--help"] })).toBe("rotate <degrees>");
    const observations = await send(path, { kind: "sensor", id: "thermal-9", argv: ["sample"] });
    expect(observations).toMatchObject([{ sensorId: "thermal-9", mediaType: "text/plain" }]);
    const { epoch } = await runtime.start();
    expect(await send(path, { kind: "controller", id: "joint-7", argv: ["rotate", "15"], epoch: epoch! })).toMatchObject({ stdout: "15" });
    await runtime.stop();
    expect(owner()).toBeUndefined();
    await runtime.start();
    await expect(send(path, { kind: "controller", id: "joint-7", argv: ["rotate", "3"], epoch: epoch! })).rejects.toThrow("STALE_EPOCH");
  } finally { await runtime.close(); await close(); }
});

test("subcommand help does not acquire controls or sample sensors and preserves literal option values", async () => {
  const { runtime, controller, owner } = fixture();
  const execute = spyOn(controller, "execute");
  const read = spyOn(runtime.capabilities.sensors[0]!, "read");
  try {
    expect(await dispatch(runtime, { kind: "controller", id: "joint-7", argv: ["rotate", "--help"] })).toBe("rotate <degrees>");
    expect(await dispatch(runtime, { kind: "sensor", id: "thermal-9", argv: ["sample", "--help"] })).toBe("sample");
    expect(owner()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const { epoch } = await runtime.start();
    await expect(dispatch(runtime, { kind: "controller", id: "joint-7", argv: ["type", "--text", "--help"], epoch: epoch! })).rejects.toThrow("unknown operation");
    expect(execute.mock.calls[0]![0]).toEqual(["type", "--text", "--help"]);
  } finally { await runtime.close(); execute.mockRestore(); read.mockRestore(); }
});

test("parallel hosts route to independent devices and reject each other's epochs", async () => {
  const a = fixture(), b = fixture();
  const socketA = `/tmp/rsa-project-a-${crypto.randomUUID()}.sock`;
  const socketB = `/tmp/rsa-project-b-${crypto.randomUUID()}.sock`;
  const closeA = await listen(socketA, a.runtime), closeB = await listen(socketB, b.runtime);
  try {
    const ownerA = await a.runtime.start(), ownerB = await b.runtime.start();
    await send(socketA, { kind: "controller", id: "joint-7", argv: ["rotate", "15"], epoch: ownerA.epoch! });
    await send(socketB, { kind: "controller", id: "joint-7", argv: ["rotate", "30"], epoch: ownerB.epoch! });
    await expect(send(socketB, { kind: "controller", id: "joint-7", argv: ["rotate", "100"], epoch: ownerA.epoch! }))
      .rejects.toThrow("STALE_EPOCH");
    expect([a.angle(), b.angle()]).toEqual([15, 30]);
    await expect(send(socketA, { kind: "auto", argv: ["off"], runId: b.runtime.status().runId })).rejects.toThrow("STALE_RUN");
    await expect(send(socketA, { kind: "auto", argv: ["off"], runId: a.runtime.status().runId, expectedEpoch: ownerB.epoch })).rejects.toThrow("STALE_EPOCH");
    expect(a.runtime.status()).toMatchObject({ mode: "auto", maxSeconds: 300 });
    await send(socketA, { kind: "auto", argv: ["off"], runId: a.runtime.status().runId, expectedEpoch: ownerA.epoch });
    expect(a.runtime.status().mode).toBe("manual");
    expect(b.runtime.status().mode).toBe("auto");
    await send(socketB, { kind: "controller", id: "joint-7", argv: ["rotate", "5"], epoch: ownerB.epoch! });
    expect([a.angle(), b.angle()]).toEqual([15, 35]);
  } finally { await a.runtime.close(); await b.runtime.close(); await closeA(); await closeB(); }
});

test("off completes device handback without waiting for the model, and prevents overlapping cycles", async () => {
  const { runtime, owner } = fixture();
  const model = Promise.withResolvers<void>();
  runtime.driver = { run: async () => model.promise, consolidate: async () => {}, abort: async () => {}, close: async () => {} };
  await runtime.start();
  await runtime.stop();
  expect(owner()).toBeUndefined();
  expect(runtime.status()).toMatchObject({ mode: "manual", thinking: true });
  await expect(runtime.start()).rejects.toThrow("Previous control cycle");
  model.resolve();
  await runtime.close();
});

test("consolidation keeps devices manual, rejects overlap, and drains cancellation before admitting another task", async () => {
  const { runtime, controller, owner } = fixture();
  let deviceCalls = 0;
  controller.acquire = controller.release = async () => { deviceCalls++; };
  runtime.capabilities.sensors[0].read = async () => { deviceCalls++; return []; };
  const prompt = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  runtime.driver = {
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
    const runtime = new Runtime({ sensors: [], controllers: [] }, (type, data) => {
      events.push({ type, data });
      if (type === "consolidation_end") done.resolve();
    });
    const prompt = Promise.withResolvers<void>();
    runtime.driver = {
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
  controller.acquire = async (epoch) => { await barrier.promise; await acquire(epoch); };
  const start = runtime.start();
  const stop = runtime.stop();
  barrier.resolve();
  await Promise.all([start, stop]);
  expect(runtime.status().mode).toBe("manual");
  expect(owner()).toBeUndefined();
  await runtime.close();
});
