import { expect, test } from "bun:test";
import { encodeSpans } from "../src/providers/mgba/provider.ts";

test("state sequences replace omitted keys and round cumulative durations without per-span drift", () => {
  expect(encodeSpans([
    { state: { A: 1, RIGHT: 1 }, durationMs: 25 },
    { state: { RIGHT: 1 }, durationMs: 25 },
    { state: {}, durationMs: 50 },
  ], 60)).toBe("17:2,16:1,0:3");
  expect(() => encodeSpans([{ state: { JUMP: 1 }, durationMs: 100 }], 60)).toThrow("Invalid channel");
  expect(() => encodeSpans([{ state: { A: 1 }, durationMs: 2001 }], 60)).toThrow("2000");
});
