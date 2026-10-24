import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capabilities, Clock, Controller, ExecutionResult } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { createPadPlayer } from "../pad.ts";
import { compileTimeline } from "../timeline.ts";
import { createTouchController } from "../touch.ts";
import { MIN_POLL_DURATION_MS, PLAY_HELP, noArguments, padCommands, polledDuration } from "../schema.ts";

// Order matches the Azahar bridge's device channels, not game actions.
export const BUTTONS = ["A", "B", "X", "Y", "L", "R", "START", "SELECT", "LEFT", "UP", "RIGHT", "DOWN", "ZL", "ZR"];
export const AXES = ["LX", "LY", "RX", "RY"];
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

const PAD_HELP = `Native 3DS controller. LX/LY are the Circle Pad; RX/RY are the C Stick.
Buttons: ${BUTTONS.join(", ")}. Values: 0=released, 1=pressed.
Axes: LX, LY, RX, RY in [-1,1]; X positive=right, Y positive=up, 0=center.
${PLAY_HELP}
Durations use wall time sampled at input polls, not emulation frames. Every state transition must be at least 16 ms apart.`;

/** Native pad, single-contact touch and independent hardware screen sources. */
export async function createAzaharProvider(options: { port: number; artifactsDir: string; clock: Clock }) {
  const { clock } = options;
  await mkdir(options.artifactsDir, { recursive: true });
  const bridge = await Bridge.open(options.port);
  try {
    const [version] = await bridge.request("HELLO");
    if (version !== "azahar-rsa-3") throw new Error(`Unexpected bridge: ${version}`);
    const player = createPadPlayer({ bridge, clock,
      encode: inputs => encodeSpans(compileTimeline(inputs, BUTTONS, AXES, MIN_POLL_DURATION_MS)),
      decode: ([elapsedMs, polls]) => ({ elapsedMs: Number(elapsedMs), inputPolls: Number(polls) }),
    });
    let owner: string | undefined;
    const acquire = async (epoch: string) => {
      if (owner === epoch) return;
      player.reset(); await bridge.request("OWN", [epoch]); owner = epoch;
    };
    const release = async (epoch: string) => {
      if (owner !== epoch) return;
      owner = undefined;
      await bridge.request("DISOWN", [epoch]);
      await player.settle();
    };
    const touch = await createTouchController({ bridge, clock, acquire, release, owns: epoch => owner === epoch });
    let captureTail = Promise.resolve();
    const screens = (["top", "bottom"] as const).map((source): Controller => {
      const controllerId = `screen.${source}`;
      const dimensions = source === "top" ? "400×240" : "320×240";
      return {
        id: controllerId, requiresControl: false, mediaTypes: ["image/png"],
        commands: [noArguments("capture", `Capture the independent native ${source} screen (${dimensions}) as PNG.`)],
        help: () => `capture\nCapture the native ${source} screen (${dimensions}) as one PNG. This is an independent hardware source; no combined layout, cropping, scaling or coordinate conversion. Returns an immutable path, sample interval and captureSequence; this sequence counts captures, not presented frames.`,
        async execute(argv, { signal }) {
          if (argv.length !== 1 || argv[0] !== "capture") throw new Error(`Usage: controller ${controllerId} capture`);
          signal.throwIfAborted();
          const id = crypto.randomUUID();
          const path = join(options.artifactsDir, `${id}.png`);
          const previous = captureTail;
          let release!: () => void;
          captureTail = new Promise<void>(resolve => { release = resolve; });
          try {
            // Both sources share one native renderer capture slot, not one image.
            await previous;
            signal.throwIfAborted();
            const requestedAtMs = clock.now();
            const [sequence] = await bridge.request("CAPTURE", [source, path], id);
            signal.throwIfAborted();
            const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
            return { id, status: "completed", exitCode: 0, stdout: JSON.stringify({ captureSequence: Number(sequence) }), stderr: "", timing,
              observations: [{ id, controllerId, mediaType: "image/png", path, timing }] };
          } finally { release(); }
        },
      };
    });
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
    return {
      capabilities: { controllers: [pad, touch, ...screens] } satisfies Capabilities,
      version: "2126.2-rsa.3",
      onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
      close() { bridge.close(); },
    };
  } catch (error) { bridge.close(); throw error; }
}
