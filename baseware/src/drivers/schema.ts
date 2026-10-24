import type { CommandSchema, JsonSchema } from "../contracts.ts";

export const MIN_POLL_DURATION_MS = 16;
export const MAX_CAPTURE_DELAY_MS = 2_147_483_647;

export function noArguments(name: string, description: string): CommandSchema {
  return { name, description,
    parameters: { type: "object", properties: {}, additionalProperties: false }, bindings: [] };
}

export const polledDuration: JsonSchema = {
  type: "integer", minimum: MIN_POLL_DURATION_MS, maximum: Number.MAX_SAFE_INTEGER,
  description: "Wall-clock milliseconds sampled at input polls. Compiled state changes must be at least 16 ms apart, including initial gaps and the final span; no duration is silently stretched.",
};

export const PLAY_HELP = `state
play --inputs '<JSON array>' [--wait true|false]
play --file <absolute JSON file path> [--wait true|false]
status --action <action ID>
wait --action <action ID>
cancel --action <action ID>
release
play inputs: [{"atMs":0,"durationMs":500,"state":{"LEFT":1}}, {"atMs":0,"durationMs":300,"state":{"B":1}}].
Files contain {"inputs":[...]}. Each entry affects only its declared channels for its interval.
atMs is relative to execution start. Different channels combine; overlapping intervals on the same channel are rejected.
Adjacent entries preserve held controls. All controls return to 0 at completion or cancellation.
play returns an action ID after submission; --wait true also waits for completion. Only one action may run; BUSY otherwise.
status/wait retain the latest 64 action results in the current ownership epoch; full results remain in the event log.
Closing a submitting or waiting client does not cancel the action. cancel targets one action; release clears input while retaining ownership.
Human takeover releases all input. state reports the bridge's applied controls and active action ID, never game memory.`;

export function padCommands(buttons: readonly string[], axes: readonly string[], duration: JsonSchema): CommandSchema[] {
  const state: JsonSchema = { type: "object", additionalProperties: false,
    description: "Only the declared channels are affected during this interval; other timeline entries can control other channels.",
    properties: {
      ...Object.fromEntries(buttons.map(key => [key, { type: "integer", enum: [0, 1] }])),
      ...Object.fromEntries(axes.map(key => [key, { type: "number", minimum: -1, maximum: 1 }])),
    } };
  const inputs: JsonSchema = { type: "array", minItems: 1,
    description: `Inputs on distinct channels may overlap; same-channel overlaps are rejected. Adjacent intervals preserve held controls. All controls return to zero at completion or cancellation. atMs + durationMs must be a safe integer. Native timing: ${duration.description ?? "See driver help."}`,
    items: { type: "object", properties: { state,
      atMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Start offset from actual execution start, in milliseconds." },
      durationMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      required: ["atMs", "durationMs", "state"], additionalProperties: false } };
  const action = (name: string, description: string): CommandSchema => ({ name, description,
    parameters: { type: "object", properties: { action: { type: "string", minLength: 1, description: "Action ID returned by play in this ownership epoch." } },
      required: ["action"], additionalProperties: false },
    bindings: [{ parameter: "action", flag: "--action", encoding: "string" }] });
  return [
    noArguments("state", "Read applied channel values and the active action ID."),
    { name: "play", description: "Submit an input timeline; return an action ID immediately or wait for completion.",
      parameters: { type: "object", properties: { inputs,
        file: { type: "string", description: "Absolute path to a JSON object containing inputs; read by the Baseware process.",
        // This describes the JSON file contents, not the file path string itself.
        "x-fileContentSchema": { type: "object", properties: { inputs }, required: ["inputs"], additionalProperties: false } },
        wait: { type: "string", enum: ["true", "false"], default: "false", description: "Wait for completion after submission." } },
        oneOf: [{ required: ["inputs"] }, { required: ["file"] }], additionalProperties: false },
      bindings: [{ parameter: "inputs", flag: "--inputs", encoding: "json" },
        { parameter: "file", flag: "--file", encoding: "string", style: "joined" },
        { parameter: "wait", flag: "--wait", encoding: "string" }] },
    action("status", "Read the submitted action's current status without waiting."),
    action("wait", "Wait for the submitted action to finish; stopping this wait does not cancel the action."),
    action("cancel", "Cancel the identified action and release its input."),
    noArguments("release", "Interrupt current input and return channels to zero, retaining ownership."),
  ];
}
