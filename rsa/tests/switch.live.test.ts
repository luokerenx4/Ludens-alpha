import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSwitchProvider } from "@playness/baseware/drivers/ryubing/provider.ts";
import { Bridge } from "@playness/baseware/drivers/bridge.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";
import type { ToolArguments, ControllerContext, ToolExecutionResult } from "@playness/baseware/contracts";
import { Runtime } from "../src/harness/runtime.ts";

function imageBytes(capture: ToolExecutionResult): Buffer {
  const block = capture.result.content[capture.observations![0].contentIndex!];
  if (block.type !== "image") throw new Error("Expected native image content");
  return Buffer.from(block.data, "base64");
}

test.skipIf(process.env.RSA_SWITCH_TEST !== "1")("Ryubing captures frames, interrupts long actions, hands back control, rejects stale epochs and clears disconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-switch-"));
  const port = Number(process.env.RSA_BRIDGE_PORT ?? 47663);
  const connect = () => createSwitchProvider({ port, clock: { id: "switch-test", now: () => performance.now() } });
  let provider = await connect();
  const signal = new AbortController().signal;
  try {
    let pad = provider.capabilities.controllers.find(controller => controller.tool.name === "pad.play")!;
    const call = (name: string, args: ToolArguments, context: ControllerContext) => provider.capabilities.controllers.find(controller => controller.tool.name === name)!.execute(args, context);
    const screen = provider.capabilities.controllers.find(controller => controller.tool.name === "screen.capture")!;
    const first = await screen.execute({}, { signal });
    const second = await screen.execute({}, { signal });
    const png = imageBytes(second);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(640);
    expect(second.observations![0].id).not.toBe(first.observations![0].id);
    expect(second.observations![0].sourceSequence!).toBeGreaterThan(first.observations![0].sourceSequence!);
    const epoch = crypto.randomUUID();
    await pad.acquire!(epoch);
    const context = {epoch, signal};
    const action = JSON.parse((await call("pad.play", {inputs: [{"atMs":0,"durationMs":30000,"state":{"RIGHT":1,"LX":0.5}}]}, context)).stdout);
    expect(action.status).toBe("running");
    const abort = new AbortController();
    const waiting = call("pad.wait", {actionId: action.actionId}, { epoch, signal: abort.signal }).catch(error => error);
    await Bun.sleep(80);
    const state = JSON.parse((await call("pad.state", {}, context)).stdout);
    expect(state.state.RIGHT).toBe(1);
    expect(state.state.LX).toBeCloseTo(0.5, 4);
    await expect(call("pad.play", {inputs: [{"atMs":0,"durationMs":100,"state":{}}]}, context)).rejects.toThrow("BUSY");
    abort.abort();
    expect(await waiting).toBeInstanceOf(Error);
    expect(JSON.parse((await call("pad.status", {actionId: action.actionId}, context)).stdout).status).toBe("running");
    const started = performance.now();
    const cancelled = await call("pad.cancel", {actionId: action.actionId}, context);
    expect(JSON.parse(cancelled.stdout).status).toBe("interrupted");
    expect(performance.now() - started).toBeLessThan(500);
    const neutral = JSON.parse((await call("pad.state", {}, context)).stdout);
    expect(Object.values(neutral.state).every(value => value === 0)).toBe(true);
    expect(neutral.actionId).toBeNull();
    const sequenceFile = join(directory, "long-sequence.json");
    await Bun.write(sequenceFile, JSON.stringify({inputs: [
      { atMs: 0, state: {}, durationMs: 5_000 },
      { atMs: 5_000, state: {}, durationMs: 25_000 },
    ]}));
    const sequence = JSON.parse((await call("pad.play", await Bun.file(sequenceFile).json(), context)).stdout);
    await Bun.sleep(2_100); // Neutral controls cross the former duration limit without navigating the game.
    const active = JSON.parse((await call("pad.state", {}, context)).stdout);
    expect(active.actionId).not.toBeNull();
    expect(Object.values(active.state).every(value => value === 0)).toBe(true);
    const sequenceStop = performance.now();
    await call("pad.cancel", {actionId: sequence.actionId}, context);
    const interrupted = await call("pad.wait", {actionId: sequence.actionId}, context);
    expect(interrupted.status).toBe("interrupted");
    expect(JSON.parse(interrupted.stdout).elapsedMs).toBeGreaterThan(2_000);
    expect(performance.now() - sequenceStop).toBeLessThan(500);
    const afterSequence = JSON.parse((await call("pad.state", {}, context)).stdout);
    expect(afterSequence.actionId).toBeNull();
    expect(Object.values(afterSequence.state).every(value => value === 0)).toBe(true);
    const finished = await call("pad.play", {inputs: [{"atMs":0,"durationMs":100,"state":{}}], wait: true}, context);
    expect(finished.status).toBe("completed");
    expect(JSON.parse(finished.stdout).elapsedMs).toBeGreaterThanOrEqual(100);
    expect(JSON.parse(finished.stdout).inputPolls).toBeGreaterThan(0);
    const disconnectedAction = JSON.parse((await call("pad.play", {inputs: [{"atMs":0,"durationMs":30000,"state":{"LEFT":1}}]}, context)).stdout);
    const lost = call("pad.wait", {actionId: disconnectedAction.actionId}, context);
    await Bun.sleep(50);
    provider.close();
    const lostResult = await lost;
    expect(lostResult.status).toBe("failed");
    expect(lostResult.stderr).toContain("disconnected");
    provider = await connect();
    pad = provider.capabilities.controllers.find(controller => controller.tool.name === "pad.play")!;
    const nextEpoch = crypto.randomUUID();
    await pad.acquire!(nextEpoch); // Confirms the emulator cleared its previous owner on disconnect.
    const afterReconnect = JSON.parse((await call("pad.state", {}, { epoch: nextEpoch, signal })).stdout);
    expect(Object.values(afterReconnect.state).every(value => value === 0)).toBe(true);
    await pad.release!(nextEpoch);
    const { core, devices } = createTestDeviceSession(provider.capabilities);
    const runtime = new Runtime(devices, () => {});
    const execute = (name: string, args: ToolArguments, epoch: string) => core.execute(name, args, epoch, signal);
    try {
      const takeover = await runtime.start(); // Agent lifecycle around the device service: no model request.
      const runtimeEpoch = takeover.epoch!;
      const longAction = JSON.parse((await execute("pad.play", {inputs: [{"atMs":0,"durationMs":30000,"state":{}}]}, runtimeEpoch)).stdout);
      expect(longAction.status).toBe("running");
      await Bun.sleep(80);
      const beforeHandback = JSON.parse((await execute("pad.state", {}, runtimeEpoch)).stdout);
      expect(beforeHandback.actionId).not.toBeNull();
      const handback = performance.now();
      await runtime.stop("human");
      expect(performance.now() - handback).toBeLessThan(500);
      expect(runtime.status()).toMatchObject({ mode: "manual", epoch: null, reason: "human" });
      await expect(execute("pad.state", {}, runtimeEpoch)).rejects.toThrow("STALE_EPOCH");
      await expect(call("pad.state", {}, { epoch: runtimeEpoch, signal })).rejects.toThrow("STALE_EPOCH");
      const resumed = await runtime.start();
      expect(resumed.epoch).not.toBe(runtimeEpoch);
      const afterHandback = JSON.parse((await execute("pad.state", {}, resumed.epoch!)).stdout);
      expect(afterHandback.actionId).toBeNull();
      expect(Object.values(afterHandback.state).every(value => value === 0)).toBe(true);
      await expect(execute("pad.state", {}, runtimeEpoch)).rejects.toThrow("STALE_EPOCH");
    } finally { await runtime.close(); }
    provider.close();
    const wire = await Bridge.open(port);
    try {
      await wire.request("OWN", [nextEpoch]);
      await expect(wire.request("APPLY", [epoch, "1:0:0:0:0:100"])).rejects.toThrow("STALE_EPOCH");
      await expect(wire.request("APPLY", [nextEpoch, "1:0:0:0:0:15"])).rejects.toThrow("Invalid state");
      await wire.request("DISOWN", [nextEpoch]);
    } finally { wire.close(); }
  } finally { provider.close(); await rm(directory, { recursive: true }); }
}, 40000);

test.skipIf(process.env.RSA_SWITCH_KEYBOARD_TEST !== "1")("foreground keyboard can be captured while the game is paused, edited, cancelled and handed back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-keyboard-"));
  const provider = await createSwitchProvider({ port: Number(process.env.RSA_BRIDGE_PORT ?? 47663),
    clock: { id: "keyboard-test", now: () => performance.now() } });
  const signal = new AbortController().signal;
  const epoch = crypto.randomUUID();
  const pad = provider.capabilities.controllers.find(controller => controller.tool.name === "pad.play")!;
  const keyboard = provider.capabilities.controllers.find(controller => controller.tool.name === "keyboard.type")!;
  const screen = provider.capabilities.controllers.find(controller => controller.tool.name === "screen.capture")!;
  const key = (name: string, args: ToolArguments) => provider.capabilities.controllers.find(controller => controller.tool.name === name)!.execute(args, { epoch, signal });
  try {
    await pad.acquire!(epoch);
    await keyboard.acquire!(epoch); // Both capabilities share the same device ownership.
    const before = await screen.execute({}, { signal });
    expect(before.observations![0].sourceSequence).toBeUndefined();
    const png = imageBytes(before);
    expect(png.readUInt32BE(16)).toBeGreaterThan(100);
    await key("keyboard.press", {key: "CTRL+A"});
    await key("keyboard.type", {text: "123456789"}); // Fire Emblem's visible dialog currently limits input to eight characters.
    await expect(key("keyboard.press", {key: "ENTER"})).rejects.toThrow("TEXT_INVALID");
    await key("keyboard.press", {key: "CTRL+A"});
    await key("keyboard.type", {text: "RSA"});
    await key("keyboard.press", {key: "BACKSPACE"});
    const after = await screen.execute({}, { signal });
    expect(after.observations![0].sourceSequence).toBeUndefined();
    expect(imageBytes(after)).not.toEqual(imageBytes(before));
    await key("keyboard.press", {key: "ESCAPE"});
    await Bun.sleep(300);
    await expect(key("keyboard.type", {text: "x"})).rejects.toThrow("NO_TEXT_INPUT");
    await keyboard.release!(epoch);
    await pad.release!(epoch);
    await expect(key("keyboard.press", {key: "ENTER"})).rejects.toThrow("STALE_EPOCH");
  } finally { await pad.release!(epoch); provider.close(); await rm(directory, { recursive: true }); }
}, 20000);
