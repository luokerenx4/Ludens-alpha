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
  type: "object", required: ["id", "status", "exitCode", "stdout", "stderr", "timing", "result"],
  properties: {
    id: { type: "string" }, status: { enum: ["completed", "interrupted", "failed"] },
    actionId: { type: "string", description: "Separately running device action. Command completion does not imply action completion; inspect result.structuredContent.status or wait by this ID." },
    readOnly: { type: "boolean", description: "State query; does not change device input even when it requires ownership." },
    exitCode: { type: "integer" }, stdout: { type: "string", description: "Driver output; read result.structuredContent and the tool outputSchema when declared." },
    stderr: { type: "string" }, timing: timingSchema,
    result: { type: "object", required: ["content"], description: "Unmodified native MCP CallToolResult: content, structuredContent, isError and metadata. Consult each tool outputSchema for structuredContent." },
    observations: { type: "array", items: {
      type: "object", required: ["id", "controllerId", "mediaType", "timing"],
      properties: { id: { type: "string" }, controllerId: { type: "string" }, mediaType: { type: "string" },
        path: { type: "string", description: "Explicit caller-owned output or a timeline asset; inline native media has no path." },
        timeline: { type: "object", required: ["asset"], properties: {
          recordId: { type: "string" }, sequence: { type: "integer" }, asset: { type: "string" },
        } },
        data: { type: "string", description: "Optional transient base64 media, excluded from event logs." },
        timing: timingSchema, sourceSequence: { type: "number" }, contentIndex: { type: "integer", minimum: 0 } },
    } },
  },
};

/** A readable snapshot of live discovery, with the same contract for every client. */
export function capabilityDocument(catalog: Catalog) {
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(),
    drivers: catalog.drivers, controllers: catalog.controllers,
    invocation: {
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", required: ["controllerId", "arguments"], additionalProperties: false,
        properties: { controllerId: { type: "string", enum: catalog.controllers.map(controller => controller.name) },
          arguments: { type: "object", description: "Parameters matching the selected controller inputSchema; no argv conversion." } },
      },
      python: { import: "from baseware import Client", call: "Client().controller(controllerId, arguments)" },
      cli: "baseware controller <name> --args '<JSON object>' (or --file <arguments.json>)",
      mcp: { tool: "<native tool name>", arguments: "Native inputSchema parameter object; no epoch or argv wrapper.",
        result: "Unmodified native CallToolResult. Baseware timing/control metadata are available in the API envelope and journal.",
        control: "BASEWARE_EPOCH is inherited by the MCP server process, outside tool arguments; MCP never acquires control automatically." },
      media: "CLI/API/MCP preserve native binary content. observations.contentIndex identifies inline media; only explicit caller-owned outputs have paths. Drivers do not archive media. The journal omits binary data/blob.",
      control: "requiresControl=true needs the caller's existing BASEWARE_EPOCH. Clients do not acquire control automatically.",
      errors: "Service/argument errors raise in the API, exit nonzero in the CLI, or set isError in MCP. A returned result can also have a nonzero exitCode or interrupted/failed status.",
    },
    executionResultSchema,
  };
}

export async function writeCapabilityDocument(catalog: Catalog, path: string) {
  const document = capabilityDocument(catalog);
  await writeFile(path, JSON.stringify(document, null, 2) + "\n");
  return document;
}
