import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Capabilities, Clock, Controller, ExecutionResult } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { createPadPlayer } from "../pad.ts";
import { compileTimeline } from "../timeline.ts";
import { createTouchController } from "../touch.ts";
import { MAX_CAPTURE_DELAY_MS, MIN_POLL_DURATION_MS, PLAY_HELP, padCommands, polledDuration } from "../schema.ts";

// Order matches the physical bits in Ryubing's ControllerKeys, not game actions.
export const BUTTONS = ["A", "B", "X", "Y", "LSTICK", "RSTICK", "L", "R", "ZL", "ZR", "PLUS", "MINUS", "LEFT", "UP", "RIGHT", "DOWN"];
export const AXES = ["LX", "LY", "RX", "RY"];
const KEYBOARD_KEYS = ["ENTER", "ESCAPE", "BACKSPACE", "CTRL+A"];
type Span = { state: Record<string, number>; durationMs: number };

export function encodeSpans(spans: Span[]): string {
  if (!Array.isArray(spans) || !spans.length) throw new Error("Expected a non-empty state sequence");
  let elapsed = 0;
  return spans.map(({ state, durationMs }) => {
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_POLL_DURATION_MS) throw new Error(`durationMs must be a safe integer >= ${MIN_POLL_DURATION_MS}`);
    elapsed += durationMs;
    if (!Number.isSafeInteger(elapsed)) throw new Error("Sequence duration must be a safe integer");
    if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("state must be an object");
    let mask = 0;
    const axes = [0, 0, 0, 0];
    for (const [key, value] of Object.entries(state)) {
      const button = BUTTONS.indexOf(key);
      const axis = AXES.indexOf(key);
      if (button >= 0 && (value === 0 || value === 1)) mask |= value << button;
      else if (axis >= 0 && Number.isFinite(value) && Math.abs(value) <= 1) axes[axis] = Math.round(value * 32767);
      else throw new Error(`Invalid channel/value: ${key}=${value}`);
    }
    return [mask, ...axes, durationMs].join(":");
  }).join(",");
}

const PAD_HELP = `One controller, player 1.
Buttons: ${BUTTONS.join(", ")}. Values: 0=released, 1=pressed.
Axes: LX, LY, RX, RY in [-1,1]; X positive=right, Y positive=up, 0=center.
${PLAY_HELP}
Durations use wall time sampled at input polls, not emulation frames. Every state transition must be at least 16 ms apart.`;

export async function createSwitchProvider(options: { port: number; artifactsDir: string; clock: Clock }) {
  const { clock } = options;
  await mkdir(options.artifactsDir, { recursive: true });
  const bridge = await Bridge.open(options.port);
  try {
    const [version] = await bridge.request("HELLO");
    if (version !== "ryubing-rsa-3") throw new Error(`Unexpected bridge: ${version}`);
  } catch (error) { bridge.close(); throw error; }
  const player = createPadPlayer({ bridge, clock,
    encode: inputs => encodeSpans(compileTimeline(inputs, BUTTONS, AXES, MIN_POLL_DURATION_MS)),
    decode: ([elapsedMs, polls]) => ({ elapsedMs: Number(elapsedMs), inputPolls: Number(polls) }),
  });
  let owner: string | undefined;
  async function acquire(epoch: string) {
    if (owner === epoch) return;
    player.reset(); await bridge.request("OWN", [epoch]); owner = epoch;
  }
  async function release(epoch: string) {
    if (owner !== epoch) return;
    owner = undefined;
    await bridge.request("DISOWN", [epoch]);
    await player.settle();
  }
  const screen: Controller = {
    id: "screen", requiresControl: false, mediaTypes: ["image/png"],
    commands: [{ name: "capture", description: "Capture the next presented game frame or the visible system text-entry dialog as PNG after an optional fixed delay.",
      parameters: { type: "object", properties: { delayMs: { type: "integer", minimum: 0, maximum: MAX_CAPTURE_DELAY_MS, default: 0,
        description: "Fixed wait before requesting a frame; does not detect whether the scene has settled." } }, additionalProperties: false },
      bindings: [{ parameter: "delayMs", flag: "--delay-ms", encoding: "string" }] }],
    help: () => "capture [--delay-ms <milliseconds>]\nWait a fixed delay before requesting the next presented game frame, or the visible system text-entry dialog when it is open, as a PNG. delay-ms defaults to 0 and accepts integer milliseconds from 0 to 2147483647. This delay does not detect whether the scene has settled. Returns an immutable path and sample interval including the delay. sourceSequence is a game presentation sequence, and is omitted for a dialog. No desktop content.",
    async execute(argv, { signal }) {
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { "delay-ms": { type: "string" } } });
      if (positionals.length !== 1 || positionals[0] !== "capture") throw new Error("Usage: controller screen capture [--delay-ms <milliseconds>]");
      const delayMs = Number(values["delay-ms"] ?? "0");
      if (values["delay-ms"]?.trim() === "" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_CAPTURE_DELAY_MS) {
        throw new Error("delay-ms must be an integer from 0 to 2147483647");
      }
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const path = join(options.artifactsDir, `${id}.png`);
      const requestedAtMs = clock.now();
      if (delayMs > 0) await delay(delayMs, undefined, { signal });
      signal.throwIfAborted();
      const [frame, surface] = await bridge.request("CAPTURE", [path]);
      signal.throwIfAborted();
      const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
      return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "", timing, observations: [{ id, controllerId: "screen", mediaType: "image/png", path,
        timing, ...(surface === "keyboard" ? {} : { sourceSequence: Number(frame) }) }] };
    },
  };
  const pad: Controller = {
    id: "pad", requiresControl: true, help: () => PAD_HELP,
    commands: padCommands(BUTTONS, AXES, polledDuration),
    acquire, release,
    async execute(argv, context): Promise<ExecutionResult> {
      const { epoch, signal } = context;
      signal.throwIfAborted();
      if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
      if (argv[0] !== "state" && argv[0] !== "release") return player.execute(argv, context);
      if (argv.length !== 1) throw new Error(`${argv[0]} accepts no arguments`);
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      let output: unknown;
      if (argv[0] === "state") {
        const [mask, lx, ly, rx, ry, actionId] = await bridge.request("STATE", [epoch], id);
        output = { state: { ...Object.fromEntries(BUTTONS.map((key, i) => [key, (Number(mask) >> i) & 1])),
          ...Object.fromEntries(AXES.map((key, i) => [key, Number([lx, ly, rx, ry][i]) / 32767])) }, actionId: actionId === "-" ? null : actionId };
      } else {
        await bridge.request("STOP", [epoch], id);
        await player.settle();
        output = { released: true };
      }
      return { id, readOnly: argv[0] === "state", status: "completed", exitCode: 0, stdout: JSON.stringify(output), stderr: "",
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
    },
  };
  const keyboard: Controller = {
    id: "keyboard", requiresControl: true, acquire, release,
    commands: [
      { name: "type", description: "Insert text at the caret in the visible system text-entry dialog, replacing selected text.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        bindings: [{ parameter: "text", flag: "--text", encoding: "string", style: "joined" }] },
      { name: "press", description: "Press a key in the visible system text-entry dialog.",
        parameters: { type: "object", properties: { key: { type: "string", enum: KEYBOARD_KEYS } }, required: ["key"], additionalProperties: false },
        bindings: [{ parameter: "key", flag: "--key", encoding: "string" }] },
    ],
    help: () => `Text-entry keyboard, available while a system text-entry dialog is visible.
type --text <text>
press --key ENTER|ESCAPE|BACKSPACE|CTRL+A
type inserts text at the caret, replacing selected text. CTRL+A selects all text.
ENTER presses the primary button if the displayed input constraints are satisfied.
ESCAPE presses the close button. Commands fail NO_TEXT_INPUT when no text surface is open.
Observe screen capture to see the current dialog and its text. These commands do not control desktop applications.`,
    async execute(argv, { epoch, signal }) {
      signal.throwIfAborted();
      if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { text: { type: "string" }, key: { type: "string" } } });
      const [command] = positionals;
      if (positionals.length !== 1 || (command !== "type" && command !== "press")) throw new Error("Expected type or press; see --help");
      const value = command === "type" ? values.text : values.key;
      if (value === undefined) throw new Error(`Missing --${command === "type" ? "text" : "key"}`);
      if (command === "press" && !KEYBOARD_KEYS.includes(value)) throw new Error("Unknown keyboard key");
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      await bridge.request("KEYBOARD", [epoch, command, Buffer.from(value).toString("base64")], id);
      return { id, status: "completed", exitCode: 0, stdout: "{}", stderr: "",
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
    },
  };
  let touch: Controller;
  try { touch = await createTouchController({ bridge, clock, acquire, release, owns: epoch => owner === epoch }); }
  catch (error) { bridge.close(); throw error; }
  return {
    capabilities: { controllers: [pad, keyboard, touch, screen] } satisfies Capabilities,
    onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
    close() { bridge.close(); },
  };
}
