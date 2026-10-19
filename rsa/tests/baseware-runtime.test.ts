import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasewareCore } from "@playness/baseware/core";
import { BasewareClient } from "@playness/baseware/client";
import { listen } from "@playness/baseware/server";
import type { Capabilities, ExecutionResult } from "@playness/baseware/contracts";
import type { EventMetadata } from "@playness/baseware/protocol";
import { connectBaseware } from "../src/harness/baseware.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { captureResult } from "./runtime-fixture.ts";

async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(1);
  }
}

async function fixture(seconds = 60, acquisition?: Promise<void>, releaseFailure = false, controllerCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), "rsa-baseware-"));
  const socket = join(directory, "baseware.sock");
  const runDir = join(directory, "logs/run-1");
  const sources = [join(directory, "device/one/frame.png"), join(directory, "device/two/frame.png")];
  const pixels = [
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  ];
  for (const [index, source] of sources.entries()) {
    await mkdir(join(source, ".."), { recursive: true });
    await writeFile(source, pixels[index]!);
  }
  let owner: string | undefined;
  let agentCalls = 0, cancellations = 0;
  const acquiring = Promise.withResolvers<void>();
  const acting = Promise.withResolvers<void>();
  const events: ({ type: string; data: any; trace: any } & EventMetadata)[] = [];
  const deviceEvents: ({ type: string; data: any; trace: any } & EventMetadata)[] = [];
  const capabilities: Capabilities = {
    controllers: [{ id: "motor", requiresControl: true, help: () => "wait",
      async acquire(epoch) { acquiring.resolve(); await acquisition; owner = epoch; },
      async release() { if (releaseFailure) throw new Error("release failed"); owner = undefined; },
      async execute(_argv, { signal }): Promise<ExecutionResult> {
        acting.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancellations++; resolve(); }, { once: true }));
        return { id: "action", status: "interrupted", exitCode: 130, stdout: "", stderr: "",
          timing: { clock: "fixture", requestedAtMs: 1, receivedAtMs: 2 } };
      },
    }, { id: "screen", requiresControl: false, mediaTypes: ["image/png"], help: () => "capture",
      async execute() { return captureResult(sources.map((path, index) => ({ id: `frame-${index}`, controllerId: "screen", path, mediaType: "image/png",
        timing: { clock: "fixture", requestedAtMs: 3, receivedAtMs: 4 } }))); },
    }],
  };
  capabilities.controllers = [
    ...Array.from({ length: controllerCount }, (_, index) => ({ ...capabilities.controllers[0]!, id: index ? `motor-${index}` : "motor" })),
    capabilities.controllers[1]!,
  ];
  const core = new BasewareCore({ capabilities, drivers: [{ id: "fake", version: "1" }],
    record: (type, data, trace, metadata) => deviceEvents.push({ type, data, trace, ...metadata }) });
  const closeServer = await listen(socket, core);
  const adapter = await connectBaseware({ socket, seconds, runDir, record: (type, data, trace, metadata) => events.push({ type, data, trace, ...metadata }) });
  const runtime = new Runtime(adapter, () => {}, seconds);
  adapter.onHandback(reason => { void runtime.stop(reason); });
  adapter.onDisconnect(error => { void runtime.disconnected(error); });
  runtime.agent = {
    async run({ signal }) {
      agentCalls++;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    consolidate: async () => {}, abort: async () => {}, close: async () => {},
  };
  const external = await BasewareClient.connect(socket);
  return { socket, runDir, sources, pixels, core, runtime, adapter, external, events, deviceEvents,
    acquiring: acquiring.promise, acting: acting.promise,
    agentCalls: () => agentCalls, owner: () => owner, cancellations: () => cancellations,
    async close() {
      await runtime.close();
      adapter.close(); external.close();
      await closeServer();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("human revoke during remote acquisition never starts the RSA agent", async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture(60, gate.promise);
  try {
    const starting = f.runtime.start();
    await f.acquiring;
    const revoking = f.external.request({ kind: "revoke" });
    await until(() => f.core.status().mode === "releasing");
    gate.resolve();
    await expect(starting).rejects.toThrow("revoked before completion");
    await revoking;
    expect(f.runtime.status().mode).toBe("manual");
    expect(f.core.status().mode).toBe("manual");
    expect(f.owner()).toBeUndefined();
    expect(f.agentCalls()).toBe(0);
  } finally { gate.resolve(); await f.close(); }
});

test("remote lease matches the configured budget and human revoke cancels a separate caller", async () => {
  const f = await fixture(7);
  try {
    const state = await f.runtime.start();
    expect(state).toMatchObject({ mode: "auto", maxSeconds: 7, remainingSeconds: 7 });
    expect(await f.external.request({ kind: "status" })).toMatchObject({ mode: "auto", epoch: state.epoch, remainingSeconds: 7 });
    const action = f.external.request({ kind: "controller", id: "motor", argv: ["wait"], epoch: state.epoch! });
    await f.acting;
    await f.external.request({ kind: "revoke" });
    expect(await action).toMatchObject({ status: "interrupted", exitCode: 130 });
    await until(() => f.runtime.status().mode === "manual");
    expect(f.cancellations()).toBe(1);
    expect(f.owner()).toBeUndefined();
  } finally { await f.close(); }
});

test("RSA stop cancels a direct Baseware client operation and releases the service owner", async () => {
  const f = await fixture();
  try {
    const { epoch } = await f.runtime.start();
    const action = f.external.request({ kind: "controller", id: "motor", argv: ["wait"], epoch: epoch! });
    await f.acting;
    await f.runtime.stop();
    expect(await action).toMatchObject({ status: "interrupted", exitCode: 130 });
    expect(f.runtime.status().mode).toBe("manual");
    expect(f.core.status().mode).toBe("manual");
    expect(f.cancellations()).toBe(1);
    expect(f.owner()).toBeUndefined();
  } finally { await f.close(); }
});

test("owner connection loss revokes a separate caller and disconnects RSA", async () => {
  const f = await fixture();
  try {
    const { epoch } = await f.runtime.start();
    const action = f.external.request({ kind: "controller", id: "motor", argv: ["wait"], epoch: epoch! });
    await f.acting;
    f.adapter.close();
    expect(await action).toMatchObject({ status: "interrupted", exitCode: 130 });
    await until(() => f.core.status().mode === "manual" && !f.runtime.status().connected);
    expect(f.owner()).toBeUndefined();
    expect(f.cancellations()).toBe(1);
  } finally { await f.close(); }
});

test("remote observations and event paths keep distinct durable files inside the RSA run", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.observe({ controllerId: "screen", argv: ["capture"] }, new AbortController().signal,
      { toolCallId: "capture-call" }, "explicit");
    const observations = result.observations!;
    expect(new Set(observations.map(observation => observation.path)).size).toBe(2);
    const recorded = f.events.filter(event => event.type === "observation");
    expect(recorded).toHaveLength(2);
    expect(f.events.find(event => event.type === "execution")!.data.observations).toEqual(observations);
    for (const [index, observation] of observations.entries()) {
      expect(observation.path.startsWith(join(f.runDir, "observations") + "/")).toBe(true);
      expect(recorded[index]).toMatchObject({ data: { id: observation.id, path: observation.path }, trace: { toolCallId: "capture-call" } });
      const original = f.deviceEvents.find(event => event.type === "observation" && event.data.id === observation.id)!;
      expect(recorded[index]!.source).toEqual({ component: "baseware", implementation: "baseware" });
      expect(recorded[index]!.origin).toEqual(original.origin);
      expect(recorded[index]!.trace).toEqual(original.trace);
      expect(recorded[index]!.data.path).not.toBe(original.data.path);
      await rm(f.sources[index]!);
      expect(await readFile(observation.path)).toEqual(f.pixels[index]!);
    }
  } finally { await f.close(); }
});

test("an already disconnected Baseware service cannot appear as a connected RSA device", async () => {
  const f = await fixture();
  try {
    await f.core.disconnected(new Error("fixture disconnected"));
    await expect(connectBaseware({ socket: f.socket, seconds: 60, runDir: f.runDir, record: () => {} })).rejects.toThrow("disconnected");
  } finally { await f.close(); }
});

test("a failed physical release disconnects RSA even when handback itself succeeds", async () => {
  const f = await fixture(60, undefined, true);
  try {
    await f.runtime.start();
    await f.runtime.stop();
    expect(f.core.status()).toMatchObject({ mode: "manual", connected: false });
    expect(f.runtime.status()).toMatchObject({ mode: "manual", connected: false });
  } finally { await f.close(); }
});


test.each([0, 2])("RSA acquires one service lease for a catalog with %i controllers", async (count) => {
  const f = await fixture(60, undefined, false, count);
  const acquire = spyOn(f.core, "acquire"), release = spyOn(f.core, "release");
  try {
    expect(f.runtime.list().controllers.filter(controller => controller.requiresControl)).toHaveLength(count);
    const state = await f.runtime.start();
    expect(f.core.status()).toMatchObject({ mode: "auto", epoch: state.epoch });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.agentCalls()).toBe(1);
    await f.external.request({ kind: "revoke" });
    await until(() => f.runtime.status().mode === "manual" && !f.runtime.status().thinking);
    expect(f.core.status().mode).toBe("manual");
    expect(release).toHaveBeenCalledTimes(1);
  } finally { acquire.mockRestore(); release.mockRestore(); await f.close(); }
});
