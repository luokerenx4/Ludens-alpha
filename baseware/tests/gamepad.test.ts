import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "./driver-fixture.ts";
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
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const paths: string[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const [id, operation, path] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        if (operation === "HELLO") socket.write(`${id}\tOK\t60\t1\n`);
        else if (operation === "CAPTURE") { paths.push(path); void writeFile(path, png).then(() => socket.write(`${id}\tOK\t42\n`)); }
        else socket.write(`${id}\tERROR\tUnexpected ${operation}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createGbaProvider({ port: (server.address() as AddressInfo).port,
    clock: { id: "test", now: () => performance.now() } });
  try {
    const pad = provider.capabilities.controllers.find(c => c.tool.name === "pad.play")!;
    const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
    expect(provider.capabilities.controllers.some(c => c.tool.name === "pad.apply")).toBe(false);
    expect(pad.tool.inputSchema).toMatchObject({ properties: {
      inputs: { type: "array", description: expect.stringContaining("60 frames per second"), items: { properties: {
        state: { additionalProperties: false, properties: { A: { type: "integer", enum: [0, 1] }, SELECT: { enum: [0, 1] } } },
        durationMs: { type: "integer", minimum: 1 },
      } } },
    } });
    expect(screen.tool).toMatchObject({ name: "screen.capture", inputSchema: { properties: {}, additionalProperties: false } });
    const capture = await call(screen, {}, { signal: new AbortController().signal });
    expect(capture.result.structuredContent).toMatchObject({ source: "screen", sourceSequence: 42, timing: capture.timing });
    expect(capture.observations![0].path).toBeUndefined();
    for (const path of paths) await expect(access(path)).rejects.toThrow();
    expect(capture.observations![0]).toMatchObject({ controllerId: "screen.capture", sourceSequence: 42, contentIndex: 0 });
    expect(capture.result.content[capture.observations![0].contentIndex!]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(encodeSpans([{ state: { A: 1 }, durationMs: 30_000 }], 60)).toBe("1:1800");
  } finally {
    provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
