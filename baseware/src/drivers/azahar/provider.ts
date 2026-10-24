import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capabilities, Clock, Controller } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { structuredResult, toolExecution } from "../../tool-contract.ts";
import { createPadPlayer } from "../pad.ts";
import { compileTimeline } from "../timeline.ts";
import { createTouchControllers } from "../touch.ts";
import { MIN_POLL_DURATION_MS, NO_ARGUMENTS, padTools, POLLED_TIMING } from "../schema.ts";

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

const PAD_DESCRIPTION = "Native 3DS controller; LX/LY are the Circle Pad and RX/RY the C Stick. Axes are in [-1,1]; X positive=right, Y positive=up, 0=center.";

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
    const touch = await createTouchControllers({ bridge, clock, acquire, release, owns: epoch => owner === epoch });
    let captureTail = Promise.resolve();
    const screens = (["top", "bottom"] as const).map((source): Controller => {
      const controllerId = `screen.${source}`;
      const dimensions = source === "top" ? "400×240" : "320×240";
      return {
        tool: { name: `${controllerId}.capture`, description: `Capture the independent native ${source} screen (${dimensions}) as PNG. No combined layout, cropping, scaling or coordinate conversion. Both screens share a capture slot and are sampled serially, not simultaneously. captureSequence counts captures, not presented frames.`,
          inputSchema: NO_ARGUMENTS, annotations: { readOnlyHint: true } },
        requiresControl: false, mediaTypes: ["image/png"],
        async execute(_args, { signal }) {
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
            const output = { source: controllerId, width: source === "top" ? 400 : 320, height: 240, captureSequence: Number(sequence), timing };
            const result = structuredResult(output);
            result.content.unshift({ type: "image", mimeType: "image/png", data: (await readFile(path)).toString("base64") });
            return { ...toolExecution(clock, requestedAtMs, result, { id }), timing,
              observations: [{ id, controllerId: `${controllerId}.capture`, mediaType: "image/png", path, timing, contentIndex: 0 }] };
          } finally { release(); }
        },
      };
    });
    const pads: Controller[] = padTools(BUTTONS, AXES, POLLED_TIMING).map(tool => ({
      tool: { ...tool, description: `${PAD_DESCRIPTION} ${tool.description}` }, requiresControl: true, acquire, release,
      async execute(args, context) {
        const { epoch, signal } = context;
        signal.throwIfAborted();
        if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
        const command = tool.name.slice("pad.".length);
        if (command !== "state" && command !== "release") return player.execute(command, args, context);
        const id = crypto.randomUUID();
        const requestedAtMs = clock.now();
        let output: Record<string, unknown>;
        if (command === "state") {
          const [mask, lx, ly, rx, ry, actionId] = await bridge.request("STATE", [epoch], id);
          output = { state: { ...Object.fromEntries(BUTTONS.map((key, i) => [key, (Number(mask) >> i) & 1])),
            ...Object.fromEntries(AXES.map((key, i) => [key, Number([lx, ly, rx, ry][i]) / 32767])) }, actionId: actionId === "-" ? null : actionId };
        } else {
          await bridge.request("STOP", [epoch], id);
          await player.settle();
          output = { released: true };
        }
        return toolExecution(clock, requestedAtMs, structuredResult(output), { id, readOnly: command === "state" });
      },
    }));
    return {
      capabilities: { controllers: [...pads, ...touch, ...screens] } satisfies Capabilities,
      version: "2126.2-rsa.3",
      onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
      close() { bridge.close(); },
    };
  } catch (error) { bridge.close(); throw error; }
}
