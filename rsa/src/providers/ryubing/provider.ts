import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Capabilities, Clock, Controller, ExecutionResult, Sensor } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";

// Order matches the physical bits in Ryubing's ControllerKeys, not game actions.
export const BUTTONS = ["A", "B", "X", "Y", "LSTICK", "RSTICK", "L", "R", "ZL", "ZR", "PLUS", "MINUS", "LEFT", "UP", "RIGHT", "DOWN"];
export const AXES = ["LX", "LY", "RX", "RY"];
type Span = { state: Record<string, number>; durationMs: number };

export function encodeSpans(spans: Span[]): string {
  if (!Array.isArray(spans) || !spans.length) throw new Error("Expected a non-empty state sequence");
  let elapsed = 0;
  return spans.map(({ state, durationMs }) => {
    if (!Number.isInteger(durationMs) || durationMs < 16) throw new Error("durationMs must be an integer >= 16");
    elapsed += durationMs;
    if (elapsed > 2000) throw new Error("A sequence may last at most 2000 ms");
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
state
apply --state '<JSON object>' --for-ms <milliseconds>
play --file <absolute JSON file path>
release
apply replaces the entire state; omitted channels are 0. play accepts
[{"state":{"A":1},"durationMs":100}, ...]. Adjacent spans preserve held controls.
Durations use wall time sampled at input polls, not emulation frames. Each span
is an integer >= 16 ms; total <= 2000 ms. Commands wait for completion.
All controls return to 0 at completion or cancellation. One action at a time; BUSY otherwise.
release interrupts the action but retains ownership. Human auto off restores human input.
state reports the bridge's current controls and action ID, never game memory.`;

export async function createSwitchProvider(options: { port: number; artifactsDir: string; clock: Clock }) {
  const { clock } = options;
  await mkdir(options.artifactsDir, { recursive: true });
  const bridge = await Bridge.open(options.port);
  try {
    const [version] = await bridge.request("HELLO");
    if (version !== "ryubing-rsa-2") throw new Error(`Unexpected bridge: ${version}`);
  } catch (error) { bridge.close(); throw error; }
  let owner: string | undefined;
  async function acquire(epoch: string) {
    if (owner === epoch) return;
    await bridge.request("OWN", [epoch]); owner = epoch;
  }
  async function release(epoch: string) {
    if (owner !== epoch) return;
    owner = undefined;
    await bridge.request("DISOWN", [epoch]);
  }
  const screen: Sensor = {
    id: "screen", mediaTypes: ["image/png"],
    help: () => "capture [--delay-ms <milliseconds>]\nWait a fixed delay before requesting the next presented game frame, or the visible system text-entry dialog when it is open, as a PNG. delay-ms defaults to 0 and accepts integer milliseconds from 0 to 2147483647. This delay does not detect whether the scene has settled. Returns an immutable path and sample interval including the delay. sourceSequence is a game presentation sequence, and is omitted for a dialog. No desktop content.",
    async read(argv, signal) {
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { "delay-ms": { type: "string" } } });
      if (positionals.length !== 1 || positionals[0] !== "capture") throw new Error("Usage: sensor screen capture [--delay-ms <milliseconds>]");
      const delayMs = Number(values["delay-ms"] ?? "0");
      if (values["delay-ms"]?.trim() === "" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
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
      return [{ id, sensorId: "screen", mediaType: "image/png", path,
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() }, ...(surface === "keyboard" ? {} : { sourceSequence: Number(frame) }) }];
    },
  };
  const pad: Controller = {
    id: "pad", help: () => PAD_HELP,
    acquire, release,
    async execute(argv, { epoch, signal }): Promise<ExecutionResult> {
      signal.throwIfAborted();
      if (owner !== epoch) throw new Error("STALE_EPOCH");
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { state: { type: "string" }, "for-ms": { type: "string" }, file: { type: "string" } } });
      if (positionals.length !== 1) throw new Error("Expected one controller command; see --help");
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      let status: ExecutionResult["status"] = "completed";
      let output: unknown;
      switch (positionals[0]) {
        case "state": {
          const [mask, lx, ly, rx, ry, actionId] = await bridge.request("STATE", [epoch]);
          output = { state: { ...Object.fromEntries(BUTTONS.map((key, i) => [key, (Number(mask) >> i) & 1])),
            ...Object.fromEntries(AXES.map((key, i) => [key, Number([lx, ly, rx, ry][i]) / 32767])) }, actionId: actionId === "-" ? null : actionId };
          break;
        }
        case "release": await bridge.request("STOP", [epoch]); output = { released: true }; break;
        case "apply": case "play": {
          const spans: Span[] = positionals[0] === "apply"
            ? [{ state: JSON.parse(values.state ?? "null"), durationMs: Number(values["for-ms"]) }]
            : JSON.parse(await readFile(values.file ?? "", "utf8"));
          const sequence = encodeSpans(spans);
          signal.throwIfAborted();
          const pending = bridge.request("APPLY", [epoch, sequence], id);
          const abort = () => { void bridge.request("STOP", [epoch, id]).catch(() => {}); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const [outcome, elapsedMs, polls] = await pending;
            status = outcome as "completed" | "interrupted";
            output = { elapsedMs: Number(elapsedMs), inputPolls: Number(polls) };
          } finally { signal.removeEventListener("abort", abort); }
          break;
        }
        default: throw new Error("Unknown controller command; see --help");
      }
      return { id, status, exitCode: status === "completed" ? 0 : 130, stdout: JSON.stringify(output), stderr: "",
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
    },
  };
  const keyboard: Controller = {
    id: "keyboard", acquire, release,
    help: () => `Text-entry keyboard, available while a system text-entry dialog is visible.
type --text <text>
press --key ENTER|ESCAPE|BACKSPACE|CTRL+A
type inserts text at the caret, replacing selected text. CTRL+A selects all text.
ENTER presses the primary button if the displayed input constraints are satisfied.
ESCAPE presses the close button. Commands fail NO_TEXT_INPUT when no text surface is open.
Observe screen capture to see the current dialog and its text. These commands do not control desktop applications.`,
    async execute(argv, { epoch, signal }) {
      signal.throwIfAborted();
      if (owner !== epoch) throw new Error("STALE_EPOCH");
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { text: { type: "string" }, key: { type: "string" } } });
      const [command] = positionals;
      if (positionals.length !== 1 || (command !== "type" && command !== "press")) throw new Error("Expected type or press; see --help");
      const value = command === "type" ? values.text : values.key;
      if (value === undefined) throw new Error(`Missing --${command === "type" ? "text" : "key"}`);
      if (command === "press" && !["ENTER", "ESCAPE", "BACKSPACE", "CTRL+A"].includes(value)) throw new Error("Unknown keyboard key");
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      await bridge.request("KEYBOARD", [epoch, command, Buffer.from(value).toString("base64")], id);
      return { id, status: "completed", exitCode: 0, stdout: "{}", stderr: "",
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
    },
  };
  return {
    capabilities: { sensors: [screen], controllers: [pad, keyboard] } satisfies Capabilities,
    onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
    close() { bridge.close(); },
  };
}
