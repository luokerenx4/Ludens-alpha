import { writeFile } from "node:fs/promises";
import type { JsonSchema } from "./contracts.ts";
import type { Catalog } from "./protocol.ts";

const timingSchema: JsonSchema = {
  type: "object", required: ["clock", "requestedAtMs", "receivedAtMs"],
  properties: { clock: { type: "string" }, requestedAtMs: { type: "number" }, receivedAtMs: { type: "number" } },
  description: "Monotonic milliseconds in the named clock; different clocks cannot be subtracted.",
};

export const executionResultSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", required: ["id", "status", "exitCode", "stdout", "stderr", "timing"],
  properties: {
    id: { type: "string" }, status: { enum: ["completed", "interrupted", "failed"] },
    exitCode: { type: "integer" }, stdout: { type: "string", description: "Driver output; see controller.stdoutSchema when declared." },
    stderr: { type: "string" }, timing: timingSchema,
    observations: { type: "array", items: {
      type: "object", required: ["id", "controllerId", "mediaType", "path", "timing"],
      properties: { id: { type: "string" }, controllerId: { type: "string" }, mediaType: { type: "string" },
        path: { type: "string", description: "Local file containing the observation; read the file to consume its media." },
        timing: timingSchema, sourceSequence: { type: "number" } },
    } },
  },
};

/** A readable snapshot of live discovery, with the same contract for every client. */
export function capabilityDocument(catalog: Catalog) {
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    drivers: catalog.drivers, controllers: catalog.controllers,
    invocation: {
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", required: ["controllerId", "argv"], additionalProperties: false,
        properties: { controllerId: { type: "string", enum: catalog.controllers.map(controller => controller.id) },
          argv: { type: "array", items: { type: "string" } } },
      },
      python: { import: "from baseware import Client", call: "Client().controller(controllerId, argv)" },
      cli: "baseware controller <controllerId> <argv...>",
      mcp: { tool: "baseware_controller_<controllerId>", arguments: "{argv: string[], epoch?: string}",
        naming: "Characters outside a-z, A-Z, 0-9, _, ., - in controllerId are replaced with _.",
        result: "content[0].text contains the JSON execution result, followed by image blocks. Errors set isError=true; service errors return an error message instead of an execution result." },
      control: "requiresControl=true needs the caller's existing BASEWARE_EPOCH. Clients do not acquire control automatically.",
      errors: "Service/argument errors raise in the API, exit nonzero in the CLI, or set isError in MCP. A returned result can also have a nonzero exitCode or interrupted/failed status.",
    },
    commandEncoding: {
      description: "commands describe named parameter objects, not a new RPC interface. Build argv using the rules below, then call an existing client.",
      prefix: "Start with command.name unless it is empty.",
      bindings: "Visit bindings in order. For each supplied parameter, append its flag if present, then one encoded value. style=joined emits flag=value as one token, preserving leading dashes in values. Omit absent optional parameters.",
      string: "Encode numbers and strings as one string token; do not shell-split it.",
      json: "Serialize the parameter as one JSON string token.",
      files: "x-fileContentSchema describes JSON stored in the file named by a path parameter, not the path string itself.",
      defaults: "An omitted parameter uses the driver default documented in parameters/help.",
    },
    executionResultSchema,
  };
}

export async function writeCapabilityDocument(catalog: Catalog, path: string) {
  const document = capabilityDocument(catalog);
  await writeFile(path, JSON.stringify(document, null, 2) + "\n");
  return document;
}
