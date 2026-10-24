import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbaProvider, encodeSpans } from "../src/drivers/mgba/provider.ts";

test("state sequences replace omitted keys and round cumulative durations without per-span drift", () => {
  expect(encodeSpans([
    { state: { A: 1, RIGHT: 1 }, durationMs: 25 },
    { state: { RIGHT: 1 }, durationMs: 25 },
    { state: {}, durationMs: 50 },
  ], 60)).toBe("17:2,16:1,0:3");
  expect(() => encodeSpans([{ state: { JUMP: 1 }, durationMs: 100 }], 60)).toThrow("Invalid channel");
});

test("GBA accepts long actions and sequences while rejecting invalid durations and frame overflow", () => {
  expect(encodeSpans([{ state: { A: 1 }, durationMs: 30_000 }], 60)).toBe("1:1800");
  expect(encodeSpans([
    { state: { A: 1 }, durationMs: 5_000 },
    { state: {}, durationMs: 25_000 },
  ], 60)).toBe("1:300,0:1500");
  for (const durationMs of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    expect(() => encodeSpans([{ state: {}, durationMs }], 60)).toThrow();
  }
  expect(() => encodeSpans([
    { state: {}, durationMs: Number.MAX_SAFE_INTEGER },
    { state: {}, durationMs: Number.MAX_SAFE_INTEGER },
  ], 1000)).toThrow();
});

test("GBA catalog exposes digital states and emulation-time durations without an invented two-second bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-gba-catalog-"));
  const server = createServer(socket => {
    socket.once("data", data => {
      const [id, operation] = data.toString().trim().split("\t");
      expect(operation).toBe("HELLO");
      socket.write(`${id}\tOK\t60\t1\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createGbaProvider({ port: (server.address() as AddressInfo).port,
    artifactsDir: directory, clock: { id: "test", now: () => performance.now() } });
  try {
    const [pad, screen] = provider.capabilities.controllers;
    expect(pad.commands?.some(c => c.name === "apply")).toBe(false);
    expect(pad.commands?.find(c => c.name === "play")?.parameters).toMatchObject({ properties: {
      inputs: { type: "array", description: expect.stringContaining("60 frames per second"), items: { properties: {
        state: { additionalProperties: false, properties: { A: { type: "integer", enum: [0, 1] }, SELECT: { enum: [0, 1] } } },
        durationMs: { type: "integer", minimum: 1 },
      } } },
    } });
    expect(screen.commands).toMatchObject([{ name: "capture", parameters: { properties: {}, additionalProperties: false }, bindings: [] }]);
    expect(encodeSpans([{ state: { A: 1 }, durationMs: 30_000 }], 60)).toBe("1:1800");
  } finally {
    provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
