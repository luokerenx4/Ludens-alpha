import { expect, test } from "bun:test";
import { send } from "../src/harness/transport.ts";
import { BasewareClient } from "@playness/baseware/client";
import { defaultSocket } from "@playness/baseware/address";
import type { ExecutionResult } from "@playness/baseware/contracts";
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
    const command = (argv: string[]) => baseware.request({ kind: "controller", id: "pad", argv, epoch }) as Promise<ExecutionResult>;
    await Bun.write(sequenceFile, JSON.stringify([
      { state: { RIGHT: 1 }, durationMs: 50 },
      { state: { RIGHT: 1, A: 1 }, durationMs: 50 },
      { state: {}, durationMs: 50 },
    ]));
    const sequence = await command(["play", "--file", sequenceFile]);
    expect(sequence.status).toBe("completed");
    expect(JSON.parse(sequence.stdout).frames).toBe(9);
    const result = await command(["apply", "--state", '{"LEFT":1,"A":1}', "--for-ms", "100"]);
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.stdout).frames).toBe(6);
    const state = JSON.parse((await command(["state"])).stdout);
    expect(Object.values(state.state).every((v) => v === 0)).toBe(true);
    const capture = (await baseware.request({ kind: "controller", id: "screen", argv: ["capture"] }) as ExecutionResult).observations!;
    const png = Buffer.from(await Bun.file(capture[0].path).arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(160);
    expect(capture[0].timing.requestedAtMs).toBeGreaterThan(result.timing.receivedAtMs);

    const action = command(["apply", "--state", '{"RIGHT":1}', "--for-ms", "30000"]);
    await Bun.sleep(100);
    await expect(command(["apply", "--state", '{"A":1}', "--for-ms", "100"])).rejects.toThrow("BUSY");
    const start = performance.now();
    await control(socket, "off");
    expect((await action).status).toBe("interrupted");
    expect(performance.now() - start).toBeLessThan(500);
    await control(socket, "on");
    await expect(command(["apply", "--state", '{"A":1}', "--for-ms", "100"])).rejects.toThrow("STALE_EPOCH");
  } finally {
    try { await control(socket, "off"); }
    finally { baseware.close(); await rm(sequenceFile, { force: true }); }
  }
}, 10000);
