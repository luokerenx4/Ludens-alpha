import { expect, test } from "bun:test";
import { encodeSpans } from "../src/drivers/mgba/provider.ts";

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
