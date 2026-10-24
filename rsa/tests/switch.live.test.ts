import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSwitchProvider } from "@playness/baseware/drivers/ryubing/provider.ts";
import { Bridge } from "@playness/baseware/drivers/bridge.ts";
import { createTestDeviceSession } from "./runtime-fixture.ts";
import { Runtime } from "../src/harness/runtime.ts";

test.skipIf(process.env.RSA_SWITCH_TEST !== "1")("Ryubing captures frames, interrupts long actions, hands back control, rejects stale epochs and clears disconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-switch-"));
  const port = Number(process.env.RSA_BRIDGE_PORT ?? 47663);
  const connect = () => createSwitchProvider({ port, artifactsDir: directory, clock: { id: "switch-test", now: () => performance.now() } });
  let provider = await connect();
  const signal = new AbortController().signal;
  try {
    let pad = provider.capabilities.controllers[0];
    const screen = provider.capabilities.controllers.find(controller => controller.id === "screen")!;
    const first = (await screen.execute(["capture"], { signal })).observations![0]!;
    const second = (await screen.execute(["capture"], { signal })).observations![0]!;
    const png = Buffer.from(await Bun.file(second.path).arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(640);
    expect(second.path).not.toBe(first.path);
    expect(second.sourceSequence!).toBeGreaterThan(first.sourceSequence!);
    const epoch = crypto.randomUUID();
    await pad.acquire!(epoch);
    const context = {epoch, signal};
    const action = JSON.parse((await pad.execute(["play", "--inputs", '[{"atMs":0,"durationMs":30000,"state":{"RIGHT":1,"LX":0.5}}]'], context)).stdout);
    expect(action.status).toBe("running");
    const abort = new AbortController();
    const waiting = pad.execute(["wait", "--action", action.actionId], { epoch, signal: abort.signal }).catch(error => error);
    await Bun.sleep(80);
    const state = JSON.parse((await pad.execute(["state"], context)).stdout);
    expect(state.state.RIGHT).toBe(1);
    expect(state.state.LX).toBeCloseTo(0.5, 4);
    await expect(pad.execute(["play", "--inputs", '[{"atMs":0,"durationMs":100,"state":{}}]'], context)).rejects.toThrow("BUSY");
    abort.abort();
    expect(await waiting).toBeInstanceOf(Error);
    expect(JSON.parse((await pad.execute(["status", "--action", action.actionId], context)).stdout).status).toBe("running");
    const started = performance.now();
    const cancelled = await pad.execute(["cancel", "--action", action.actionId], context);
    expect(JSON.parse(cancelled.stdout).status).toBe("interrupted");
    expect(performance.now() - started).toBeLessThan(500);
    const neutral = JSON.parse((await pad.execute(["state"], context)).stdout);
    expect(Object.values(neutral.state).every(value => value === 0)).toBe(true);
    expect(neutral.actionId).toBeNull();
    const sequenceFile = join(directory, "long-sequence.json");
    await Bun.write(sequenceFile, JSON.stringify({inputs: [
      { atMs: 0, state: {}, durationMs: 5_000 },
      { atMs: 5_000, state: {}, durationMs: 25_000 },
    ]}));
    const sequence = JSON.parse((await pad.execute(["play", "--file", sequenceFile], context)).stdout);
    await Bun.sleep(2_100); // Neutral controls cross the former duration limit without navigating the game.
    const active = JSON.parse((await pad.execute(["state"], context)).stdout);
    expect(active.actionId).not.toBeNull();
    expect(Object.values(active.state).every(value => value === 0)).toBe(true);
    const sequenceStop = performance.now();
    await pad.execute(["cancel", "--action", sequence.actionId], context);
    const interrupted = await pad.execute(["wait", "--action", sequence.actionId], context);
    expect(interrupted.status).toBe("interrupted");
    expect(JSON.parse(interrupted.stdout).elapsedMs).toBeGreaterThan(2_000);
    expect(performance.now() - sequenceStop).toBeLessThan(500);
    const afterSequence = JSON.parse((await pad.execute(["state"], context)).stdout);
    expect(afterSequence.actionId).toBeNull();
    expect(Object.values(afterSequence.state).every(value => value === 0)).toBe(true);
    const finished = await pad.execute(["play", "--inputs", '[{"atMs":0,"durationMs":100,"state":{}}]', "--wait", "true"], context);
    expect(finished.status).toBe("completed");
    expect(JSON.parse(finished.stdout).elapsedMs).toBeGreaterThanOrEqual(100);
    expect(JSON.parse(finished.stdout).inputPolls).toBeGreaterThan(0);
    const disconnectedAction = JSON.parse((await pad.execute(["play", "--inputs", '[{"atMs":0,"durationMs":30000,"state":{"LEFT":1}}]'], context)).stdout);
    const lost = pad.execute(["wait", "--action", disconnectedAction.actionId], context);
    await Bun.sleep(50);
    provider.close();
    const lostResult = await lost;
    expect(lostResult.status).toBe("failed");
    expect(lostResult.stderr).toContain("disconnected");
    provider = await connect();
    pad = provider.capabilities.controllers[0];
    const nextEpoch = crypto.randomUUID();
    await pad.acquire!(nextEpoch); // Confirms the emulator cleared its previous owner on disconnect.
    const afterReconnect = JSON.parse((await pad.execute(["state"], { epoch: nextEpoch, signal })).stdout);
    expect(Object.values(afterReconnect.state).every(value => value === 0)).toBe(true);
    await pad.release!(nextEpoch);
    const { core, devices } = createTestDeviceSession(provider.capabilities);
    const runtime = new Runtime(devices, () => {});
    const execute = (argv: string[], epoch: string) => core.execute("pad", argv, epoch, signal);
    try {
      const takeover = await runtime.start(); // Agent lifecycle around the device service: no model request.
      const runtimeEpoch = takeover.epoch!;
      const longAction = JSON.parse((await execute(["play", "--inputs", '[{"atMs":0,"durationMs":30000,"state":{}}]'], runtimeEpoch)).stdout);
      expect(longAction.status).toBe("running");
      await Bun.sleep(80);
      const beforeHandback = JSON.parse((await execute(["state"], runtimeEpoch)).stdout);
      expect(beforeHandback.actionId).not.toBeNull();
      const handback = performance.now();
      await runtime.stop("human");
      expect(performance.now() - handback).toBeLessThan(500);
      expect(runtime.status()).toMatchObject({ mode: "manual", epoch: null, reason: "human" });
      await expect(execute(["state"], runtimeEpoch)).rejects.toThrow("STALE_EPOCH");
      await expect(pad.execute(["state"], { epoch: runtimeEpoch, signal })).rejects.toThrow("STALE_EPOCH");
      const resumed = await runtime.start();
      expect(resumed.epoch).not.toBe(runtimeEpoch);
      const afterHandback = JSON.parse((await execute(["state"], resumed.epoch!)).stdout);
      expect(afterHandback.actionId).toBeNull();
      expect(Object.values(afterHandback.state).every(value => value === 0)).toBe(true);
      await expect(execute(["state"], runtimeEpoch)).rejects.toThrow("STALE_EPOCH");
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
  const provider = await createSwitchProvider({ port: Number(process.env.RSA_BRIDGE_PORT ?? 47663), artifactsDir: directory,
    clock: { id: "keyboard-test", now: () => performance.now() } });
  const signal = new AbortController().signal;
  const epoch = crypto.randomUUID();
  const [pad, keyboard] = provider.capabilities.controllers;
  const screen = provider.capabilities.controllers.find(controller => controller.id === "screen")!;
  const key = (...argv: string[]) => keyboard.execute(argv, { epoch, signal });
  try {
    await pad.acquire!(epoch);
    await keyboard.acquire!(epoch); // Both capabilities share the same device ownership.
    const before = (await screen.execute(["capture"], { signal })).observations![0]!;
    expect(before.sourceSequence).toBeUndefined();
    const png = Buffer.from(await Bun.file(before.path).arrayBuffer());
    expect(png.readUInt32BE(16)).toBeGreaterThan(100);
    await key("press", "--key", "CTRL+A");
    await key("type", "--text", "123456789"); // Fire Emblem's visible dialog currently limits input to eight characters.
    await expect(key("press", "--key", "ENTER")).rejects.toThrow("TEXT_INVALID");
    await key("press", "--key", "CTRL+A");
    await key("type", "--text", "RSA");
    await key("press", "--key", "BACKSPACE");
    const after = (await screen.execute(["capture"], { signal })).observations![0]!;
    expect(after.sourceSequence).toBeUndefined();
    expect(await Bun.file(after.path).arrayBuffer()).not.toEqual(await Bun.file(before.path).arrayBuffer());
    await key("press", "--key", "ESCAPE");
    await Bun.sleep(300);
    await expect(key("type", "--text", "x")).rejects.toThrow("NO_TEXT_INPUT");
    await keyboard.release!(epoch);
    await pad.release!(epoch);
    await expect(key("press", "--key", "ENTER")).rejects.toThrow("STALE_EPOCH");
  } finally { await pad.release!(epoch); provider.close(); await rm(directory, { recursive: true }); }
}, 20000);
