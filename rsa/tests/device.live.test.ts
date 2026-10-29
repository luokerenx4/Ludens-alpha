import { expect, test } from "bun:test";
import { send } from "../src/harness/transport.ts";
import { BasewareClient } from "@ludens/baseware/client";
import { defaultSocket } from "@ludens/baseware/address";
import type { ExecutionResult, ToolArguments, ToolExecutionResult } from "@ludens/baseware/contracts";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveWorkspaceState } from "../src/harness/workspace-state.ts";

async function control(socket: string, value: "on" | "off") {
  const status = await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null };
  return send(socket, { kind: "auto", argv: [value], runId: status.runId, expectedEpoch: status.epoch });
}
test.skipIf(process.env.RSA_MGBA !== "1")("real device captures PNG, completes sequences, interrupts and rejects the old owner", async () => {
  const workspace = process.env.RSA_WORKSPACE ?? process.cwd();
  const socket = process.env.RSA_SOCKET ?? (await resolveWorkspaceState(workspace, resolve(import.meta.dir, "../../../artifacts/rsa"))).socket;
  const baseware = await BasewareClient.connect(process.env.BASEWARE_SOCKET ?? await defaultSocket(workspace));
  const sequenceFile = `/tmp/rsa-sequence-${crypto.randomUUID()}.json`;
  try {
    await control(socket, "off");
    const { epoch } = await control(socket, "on") as { epoch: string };
    const command = (id: string, args: ToolArguments) => baseware.request({ kind: "controller", id, arguments: args, epoch }) as Promise<ExecutionResult>;
    await Bun.write(sequenceFile, JSON.stringify({inputs: [
      { atMs: 0, state: { RIGHT: 1 }, durationMs: 100 },
      { atMs: 50, state: { A: 1 }, durationMs: 50 },
      { atMs: 100, state: {}, durationMs: 50 },
    ]}));
    const sequence = await command("pad.play", {...await Bun.file(sequenceFile).json(), wait: true});
    expect(sequence.status).toBe("completed");
    expect(JSON.parse(sequence.stdout).frames).toBe(9);
    const result = await command("pad.play", {inputs: [{"atMs":0,"durationMs":100,"state":{"LEFT":1,"A":1}}], wait: true});
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.stdout).frames).toBe(6);
    const state = JSON.parse((await command("pad.state", {})).stdout);
    expect(Object.values(state.state).every((v) => v === 0)).toBe(true);
    const capture = await baseware.request({ kind: "controller", id: "screen.capture", arguments: {} }) as ToolExecutionResult;
    const image = capture.result.content[capture.observations![0].contentIndex!];
    if (image.type !== "image") throw new Error("Expected native image content");
    const png = Buffer.from(image.data, "base64");
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(160);
    expect(capture.observations![0].timing.requestedAtMs).toBeGreaterThan(result.timing.receivedAtMs);

    const action = JSON.parse((await command("pad.play", {inputs: [{"atMs":0,"durationMs":30000,"state":{"RIGHT":1}}]})).stdout);
    expect(action.status).toBe("running");
    await Bun.sleep(100);
    await expect(command("pad.play", {inputs: [{"atMs":0,"durationMs":100,"state":{"A":1}}]})).rejects.toThrow("BUSY");
    const start = performance.now();
    await control(socket, "off");
    expect(performance.now() - start).toBeLessThan(500);
    const resumed = await control(socket, "on") as { epoch: string };
    const neutral = JSON.parse((await baseware.request({kind: "controller", id: "pad.state", arguments: {}, epoch: resumed.epoch}) as ExecutionResult).stdout);
    expect(neutral.actionId).toBeNull();
    expect(Object.values(neutral.state).every(value => value === 0)).toBe(true);
    await expect(command("pad.play", {inputs: [{"atMs":0,"durationMs":100,"state":{"A":1}}]})).rejects.toThrow("STALE_EPOCH");
  } finally {
    try { await control(socket, "off"); }
    finally { baseware.close(); await rm(sequenceFile, { force: true }); }
  }
}, 10000);
