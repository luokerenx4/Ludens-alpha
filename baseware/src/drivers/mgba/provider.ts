import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Capabilities, Clock, Controller, ExecutionResult } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { noArguments, padCommands } from "../schema.ts";

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

const PAD_HELP = `Digital controller: ${KEYS.join(", ")}. Values: 0=released, 1=pressed.
state
apply --state '<JSON object>' --for-ms <milliseconds>
play --file <absolute JSON file path>
release
apply replaces the entire state; omitted channels are 0. play accepts
[{"state":{"A":1},"durationMs":100}, ...]. Adjacent spans preserve held keys.
Choose finite positive durations in emulation time, rounded to frame boundaries.
Each span must occupy at least one frame; total frames must be a safe integer.
Commands wait for completion. All keys return to 0 at completion or cancellation.
Only one action may run; a concurrent action fails BUSY.
release interrupts the current action, retaining ownership. Human auto off returns ownership.
state reports applied channel values and the active action ID, never game memory.`;

export async function createGbaProvider(options: { port: number; artifactsDir: string; clock: Clock }) {
  const { clock } = options;
  await mkdir(options.artifactsDir, { recursive: true });
  const bridge = await Bridge.open(options.port);
  let frequency: string, cycles: string;
  try { [frequency, cycles] = await bridge.request("HELLO"); }
  catch (error) { bridge.close(); throw error; }
  const fps = Number(frequency) / Number(cycles);
  let owner: string | undefined;

  const screen: Controller = {
    id: "screen", requiresControl: false,
    mediaTypes: ["image/png"],
    commands: [noArguments("capture", "Capture a new native 240×160 PNG image.")],
    help: () => "capture\nCapture a new 240×160 PNG image. Returns immutable path, sample interval and source sequence.",
    async execute(argv, { signal }) {
      if (argv.length !== 1 || argv[0] !== "capture") throw new Error("Usage: controller screen capture");
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const path = join(options.artifactsDir, `${id}.png`);
      const requestedAtMs = clock.now();
      const [frame] = await bridge.request("CAPTURE", [path]);
      const data = await readFile(path);
      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Capture did not produce a PNG");
      signal.throwIfAborted();
      const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
      return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "", timing, observations: [{ id, controllerId: "screen", mediaType: "image/png", path,
        timing, sourceSequence: Number(frame) }] };
    },
  };

  const pad: Controller = {
    id: "pad", requiresControl: true,
    help: () => PAD_HELP,
    commands: padCommands(KEYS, [], { type: "number", exclusiveMinimum: 0,
      description: `Finite positive emulation milliseconds, rounded cumulatively at ${fps} frames per second. Each span must occupy at least one frame and the total frame count must be a safe integer.` }),
    async acquire(epoch) { await bridge.request("OWN", [epoch]); owner = epoch; },
    async release(epoch) {
      if (owner !== epoch) return;
      owner = undefined;
      await bridge.request("DISOWN", [epoch]);
    },
    async execute(argv, { epoch, signal }): Promise<ExecutionResult> {
      signal.throwIfAborted();
      if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { state: { type: "string" }, "for-ms": { type: "string" }, file: { type: "string" } } });
      const [command] = positionals;
      if (positionals.length !== 1) throw new Error("Expected one controller command; see --help");
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      let status: ExecutionResult["status"] = "completed";
      let output: unknown;
      if (command === "state") {
        const [mask, actionId] = await bridge.request("STATE", [epoch]);
        output = { state: Object.fromEntries(KEYS.map((key, i) => [key, (Number(mask) >> i) & 1])), actionId: actionId === "-" ? null : actionId };
      } else if (command === "release") {
        await bridge.request("STOP", [epoch]);
        output = { released: true };
      } else if (command === "apply" || command === "play") {
        const spans: Span[] = command === "apply"
          ? [{ state: JSON.parse(values.state ?? "null"), durationMs: Number(values["for-ms"]) }]
          : JSON.parse(await readFile(values.file ?? "", "utf8"));
        const sequence = encodeSpans(spans, fps);
        signal.throwIfAborted();
        const pending = bridge.request("APPLY", [epoch, sequence], id);
        const abort = () => { void bridge.request("STOP", [epoch, id]).catch(() => {}); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const [outcome, startFrame, endFrame] = await pending;
          status = outcome as "completed" | "interrupted";
          output = { startFrame: Number(startFrame), endFrame: Number(endFrame), frames: Number(endFrame) - Number(startFrame) };
        } finally { signal.removeEventListener("abort", abort); }
      } else throw new Error("Unknown controller command; see --help");
      return { id, status, exitCode: status === "completed" ? 0 : 130, stdout: JSON.stringify(output), stderr: "",
        timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
    },
  };
  return {
    capabilities: { controllers: [pad, screen] } satisfies Capabilities,
    onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
    close() { bridge.close(); },
  };
}
