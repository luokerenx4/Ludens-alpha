import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capabilities, Clock, Controller } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { structuredResult, toolExecution } from "../../tool-contract.ts";
import { createPadPlayer } from "../pad.ts";
import { compileTimeline } from "../timeline.ts";
import { NO_ARGUMENTS, padTools } from "../schema.ts";

const KEYS = ["A", "B", "SELECT", "START", "RIGHT", "LEFT", "UP", "DOWN", "R", "L"];
type Span = { state: Record<string, number>; durationMs: number };

export function encodeSpans(spans: Span[], fps: number): string {
  if (!Array.isArray(spans) || !spans.length) throw new Error("Expected a non-empty state sequence");
  let elapsed = 0;
  let previousFrames = 0;
  return spans.map((span) => {
    if (!Number.isFinite(span.durationMs) || span.durationMs <= 0) throw new Error("durationMs must be positive");
    elapsed += span.durationMs;
    if (!span.state || Array.isArray(span.state) || typeof span.state !== "object") throw new Error("state must be an object");
    let mask = 0;
    for (const [key, value] of Object.entries(span.state)) {
      const index = KEYS.indexOf(key);
      if (index === -1 || (value !== 0 && value !== 1)) throw new Error(`Invalid channel/value: ${key}=${value}`);
      mask |= value << index;
    }
    const frames = Math.ceil(elapsed * fps / 1000);
    if (!Number.isSafeInteger(frames)) throw new Error("Sequence duration exceeds the safe emulation frame range");
    const duration = frames - previousFrames;
    if (duration < 1) throw new Error("Each span must occupy at least one emulation frame");
    previousFrames = frames;
    return `${mask}:${duration}`;
  }).join(",");
}

const PAD_DESCRIPTION = "Digital controller.";

export async function createGbaProvider(options: { port: number; artifactsDir: string; clock: Clock }) {
  const { clock } = options;
  await mkdir(options.artifactsDir, { recursive: true });
  const bridge = await Bridge.open(options.port);
  let frequency: string, cycles: string;
  try { [frequency, cycles] = await bridge.request("HELLO"); }
  catch (error) { bridge.close(); throw error; }
  const fps = Number(frequency) / Number(cycles);
  const player = createPadPlayer({ bridge, clock,
    encode: inputs => encodeSpans(compileTimeline(inputs, KEYS, [], 1), fps),
    decode: ([startFrame, endFrame]) => ({ startFrame: Number(startFrame), endFrame: Number(endFrame), frames: Number(endFrame) - Number(startFrame) }),
  });
  let owner: string | undefined;

  const screen: Controller = {
    tool: { name: "screen.capture", description: "Capture a new native 240×160 PNG. Returns the frame's source sequence and request/receive sample interval.",
      inputSchema: NO_ARGUMENTS, annotations: { readOnlyHint: true } },
    requiresControl: false, mediaTypes: ["image/png"],
    async execute(_args, { signal }) {
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const path = join(options.artifactsDir, `${id}.png`);
      const requestedAtMs = clock.now();
      const [frame] = await bridge.request("CAPTURE", [path]);
      const data = await readFile(path);
      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Capture did not produce a PNG");
      signal.throwIfAborted();
      const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
      const output = { source: "screen", width: 240, height: 160, sourceSequence: Number(frame), timing };
      const result = structuredResult(output);
      result.content.unshift({ type: "image", mimeType: "image/png", data: data.toString("base64") });
      return { ...toolExecution(clock, requestedAtMs, result), timing,
        observations: [{ id, controllerId: "screen.capture", mediaType: "image/png", path, timing,
          sourceSequence: Number(frame), contentIndex: 0 }] };
    },
  };

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
  const pads: Controller[] = padTools(KEYS, [], `Integer emulation milliseconds, rounded cumulatively at ${fps} frames per second. Every state span must occupy at least one frame; total frames must be a safe integer.`).map(tool => ({
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
        const [mask, actionId] = await bridge.request("STATE", [epoch], id);
        output = { state: Object.fromEntries(KEYS.map((key, i) => [key, (Number(mask) >> i) & 1])), actionId: actionId === "-" ? null : actionId };
      } else {
        await bridge.request("STOP", [epoch], id);
        await player.settle();
        output = { released: true };
      }
      return toolExecution(clock, requestedAtMs, structuredResult(output), { id, readOnly: command === "state" });
    },
  }));
  return {
    capabilities: { controllers: [...pads, screen] } satisfies Capabilities,
    onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
    close() { bridge.close(); },
  };
}
