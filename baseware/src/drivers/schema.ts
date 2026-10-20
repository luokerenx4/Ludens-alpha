import type { CommandSchema, JsonSchema } from "../contracts.ts";

export const MIN_POLL_DURATION_MS = 16;
export const MAX_CAPTURE_DELAY_MS = 2_147_483_647;

export function noArguments(name: string, description: string): CommandSchema {
  return { name, description,
    parameters: { type: "object", properties: {}, additionalProperties: false }, bindings: [] };
}

export const polledDuration: JsonSchema = {
  type: "integer", minimum: MIN_POLL_DURATION_MS, maximum: Number.MAX_SAFE_INTEGER,
  description: "Wall-clock milliseconds sampled at input polls. The sum of all span durations must also be a safe integer.",
};

export function padCommands(buttons: readonly string[], axes: readonly string[], duration: JsonSchema): CommandSchema[] {
  const state: JsonSchema = { type: "object", additionalProperties: false,
    description: "Replaces the complete controller state; omitted channels are zero.",
    properties: {
      ...Object.fromEntries(buttons.map(key => [key, { type: "integer", enum: [0, 1], default: 0 }])),
      ...Object.fromEntries(axes.map(key => [key, { type: "number", minimum: -1, maximum: 1, default: 0 }])),
    } };
  const sequence: JsonSchema = { type: "array", minItems: 1,
    description: "Sequential spans; adjacent spans preserve held channels. All channels return to zero when the sequence completes or is cancelled.",
    items: { type: "object", properties: { state, durationMs: duration }, required: ["state", "durationMs"] } };
  return [
    noArguments("state", "Read applied channel values and the active action ID."),
    { name: "apply", description: "Apply a complete state and wait for its duration.",
      parameters: { type: "object", properties: { state, durationMs: duration }, required: ["state", "durationMs"], additionalProperties: false },
      bindings: [{ parameter: "state", flag: "--state", encoding: "json" },
        { parameter: "durationMs", flag: "--for-ms", encoding: "string" }] },
    { name: "play", description: "Read a JSON state sequence from a file and wait for completion.",
      parameters: { type: "object", properties: { file: { type: "string", description: "Absolute path to a JSON file containing the state sequence; read by the Baseware process.",
        // This describes the JSON file contents, not the file path string itself.
        "x-fileContentSchema": sequence } }, required: ["file"], additionalProperties: false },
      bindings: [{ parameter: "file", flag: "--file", encoding: "string", style: "joined" }] },
    noArguments("release", "Interrupt current input and return channels to zero, retaining ownership."),
  ];
}
