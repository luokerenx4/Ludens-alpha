import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTimeline, readPlayInputs } from "../src/drivers/timeline.ts";
import { padCommands, polledDuration } from "../src/drivers/schema.ts";

const buttons = ["LEFT", "B"];
const axes = ["LX"];
const compile = (inputs: unknown, minSpanMs?: number) => compileTimeline(inputs, buttons, axes, minSpanMs);

test("independently timed keys combine and release without dropping the longer hold", () => {
  expect(compile([
    { atMs: 0, durationMs: 500, state: { LEFT: 1 } },
    { atMs: 0, durationMs: 300, state: { B: 1 } },
  ])).toEqual([
    { durationMs: 300, state: { LEFT: 1, B: 1, LX: 0 } },
    { durationMs: 200, state: { LEFT: 1, B: 0, LX: 0 } },
  ]);
});

test("offsets, simultaneous boundary updates and analog channels share one ordered timeline", () => {
  expect(compile([
    { atMs: 200, durationMs: 100, state: { B: 1, LX: -0.5 } },
    { atMs: 100, durationMs: 100, state: { LEFT: 1 } },
    { atMs: 200, durationMs: 200, state: { LEFT: 1 } },
  ])).toEqual([
    { durationMs: 100, state: { LEFT: 0, B: 0, LX: 0 } },
    { durationMs: 100, state: { LEFT: 1, B: 0, LX: 0 } },
    { durationMs: 100, state: { LEFT: 1, B: 1, LX: -0.5 } },
    { durationMs: 100, state: { LEFT: 1, B: 0, LX: 0 } },
  ]);
  expect(compile([
    { atMs: 0, durationMs: 10, state: { LEFT: 1 } },
    { atMs: 10, durationMs: 30, state: { LEFT: 1 } },
  ])).toEqual([{ durationMs: 40, state: { LEFT: 1, B: 0, LX: 0 } }]);
});

test("same-channel overlaps are rejected, including zero values and equal values", () => {
  for (const values of [[1, 1], [1, 0], [0, 0]]) {
    expect(() => compile([
      { atMs: 100, durationMs: 100, state: { LEFT: values[0] } },
      { atMs: 0, durationMs: 150, state: { LEFT: values[1] } },
    ])).toThrow("Overlapping inputs for channel LEFT");
  }
});

test("short pulses or offsets are rejected rather than changing their timing", () => {
  for (const inputs of [
    [{ atMs: 0, durationMs: 15, state: { B: 1 } }],
    [{ atMs: 15, durationMs: 100, state: { B: 1 } }],
    [{ atMs: 0, durationMs: 500, state: { LEFT: 1 } }, { atMs: 0, durationMs: 490, state: { B: 1 } }],
  ]) expect(() => compile(inputs)).toThrow("at least 16 ms apart");
  expect(compile([{ atMs: 0, durationMs: 1, state: { B: 1 } }], 1)).toEqual([
    { durationMs: 1, state: { LEFT: 0, B: 1, LX: 0 } },
  ]);
  expect(compile([{ atMs: 0, durationMs: 100, state: {} }])).toEqual([
    { durationMs: 100, state: { LEFT: 0, B: 0, LX: 0 } },
  ]);
});

test("timeline validation rejects ambiguous input and unsafe time arithmetic", () => {
  const valid = { atMs: 0, durationMs: 100, state: { B: 1 } };
  for (const inputs of [null, {}, [], [null], [[valid]],
    [{ ...valid, typo: true }], [{ state: { B: 1 }, durationMs: 100 }],
    [{ ...valid, atMs: -1 }], [{ ...valid, atMs: "0" }], [{ ...valid, atMs: 1.5 }],
    [{ ...valid, durationMs: 0 }], [{ ...valid, durationMs: Infinity }], [{ ...valid, durationMs: "100" }],
    [{ ...valid, atMs: Number.MAX_SAFE_INTEGER }],
    [{ ...valid, durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, state: [] }], [{ ...valid, state: { A: 1 } }],
    [{ ...valid, state: { B: true } }], [{ ...valid, state: { B: 0.5 } }],
    [{ ...valid, state: { LX: NaN } }], [{ ...valid, state: { LX: 1.1 } }],
  ]) expect(() => compile(inputs)).toThrow();
});

test("play accepts exactly one inline timeline or absolute file with the current object format", async () => {
  const inputs = [{ atMs: 0, durationMs: 500, state: { LEFT: 1 } }];
  expect(await readPlayInputs({ inputs: JSON.stringify(inputs) })).toEqual(inputs);
  await expect(readPlayInputs({})).rejects.toThrow("exactly one");
  await expect(readPlayInputs({ inputs: "[]", file: "/unused" })).rejects.toThrow("exactly one");
  await expect(readPlayInputs({ file: "relative.json" })).rejects.toThrow("absolute path");
  const directory = await mkdtemp(join(tmpdir(), "baseware-timeline-"));
  const path = join(directory, "timeline.json");
  try {
    await writeFile(path, JSON.stringify({ inputs }));
    expect(await readPlayInputs({ file: path })).toEqual(inputs);
    for (const contents of [inputs, { inputs, extra: true }, { state: {}, durationMs: 100 }]) {
      await writeFile(path, JSON.stringify(contents));
      await expect(readPlayInputs({ file: path })).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("the discoverable command schema exposes only play and explicit action lifecycle commands", () => {
  const commands = padCommands(buttons, axes, polledDuration);
  expect(commands.map(command => command.name)).toEqual(["state", "play", "status", "wait", "cancel", "release"]);
  const play = commands.find(command => command.name === "play")!;
  expect(play.parameters).toMatchObject({ oneOf: [{ required: ["inputs"] }, { required: ["file"] }],
    properties: { inputs: { items: { required: ["atMs", "durationMs", "state"], additionalProperties: false } },
      wait: { enum: ["true", "false"], default: "false" },
      file: { "x-fileContentSchema": { required: ["inputs"], additionalProperties: false } } } });
  expect(play.bindings.map(binding => binding.flag)).toEqual(["--inputs", "--file", "--wait"]);
  for (const name of ["status", "wait", "cancel"]) {
    expect(commands.find(command => command.name === name)).toMatchObject({
      parameters: { required: ["action"], additionalProperties: false },
      bindings: [{ parameter: "action", flag: "--action", encoding: "string" }],
    });
  }
});
