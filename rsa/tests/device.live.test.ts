import { expect, test } from "bun:test";
import { send } from "../src/harness/transport.ts";
import type { ExecutionResult, Observation } from "../src/contracts.ts";
import { rm } from "node:fs/promises";

const socket = process.env.RSA_SOCKET ?? `/tmp/playness-rsa-${process.getuid!()}.sock`;
async function control(value: "on" | "off") {
  const status = await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null };
  return send(socket, { kind: "auto", argv: [value], runId: status.runId, expectedEpoch: status.epoch });
}
test.skipIf(process.env.RSA_MGBA !== "1")("real device captures PNG, completes sequences, interrupts and rejects the old owner", async () => {
  await control("off");
  const { epoch } = await control("on") as { epoch: string };
  const command = (argv: string[]) => send(socket, { kind: "controller", id: "pad", argv, epoch }) as Promise<ExecutionResult>;
  const sequenceFile = `/tmp/rsa-sequence-${crypto.randomUUID()}.json`;
  try {
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
    const capture = await send(socket, { kind: "sensor", id: "screen", argv: ["capture"] }) as Observation[];
    const png = Buffer.from(await Bun.file(capture[0].path).arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(160);
    expect(capture[0].timing.requestedAtMs).toBeGreaterThan(result.timing.receivedAtMs);

    const action = command(["apply", "--state", '{"RIGHT":1}', "--for-ms", "30000"]);
    await Bun.sleep(100);
    await expect(command(["apply", "--state", '{"A":1}', "--for-ms", "100"])).rejects.toThrow("BUSY");
    const start = performance.now();
    await control("off");
    expect((await action).status).toBe("interrupted");
    expect(performance.now() - start).toBeLessThan(500);
    await control("on");
    await expect(command(["apply", "--state", '{"A":1}', "--for-ms", "100"])).rejects.toThrow("STALE_EPOCH");
  } finally { await control("off"); await rm(sequenceFile, { force: true }); }
}, 10000);
