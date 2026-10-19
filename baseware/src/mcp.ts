import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BasewareClient } from "./client.ts";
import type { Request } from "./protocol.ts";

const catalogSchema = z.object({
  drivers: z.array(z.object({ id: z.string(), version: z.string() })),
  sensors: z.array(z.object({ id: z.string(), mediaTypes: z.array(z.string()), help: z.string() })),
  controllers: z.array(z.object({ id: z.string(), help: z.string() })),
});
const invocationSchema = {
  argv: z.array(z.string()).describe("Literal argument tokens, as documented by the capability's help."),
  epoch: z.string().min(1).optional().describe("Existing control epoch. Defaults to BASEWARE_EPOCH; never acquires control."),
};

async function resultContent(value: unknown, signal: AbortSignal, sensor = false): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) ?? "null" }];
  if (sensor && Array.isArray(value)) {
    for (const observation of value) {
      if (observation && typeof observation.path === "string" && typeof observation.mediaType === "string"
        && observation.mediaType.startsWith("image/")) {
        const data = await readFile(observation.path, { signal });
        content.push({ type: "image", data: data.toString("base64"), mimeType: observation.mediaType });
      }
    }
  }
  const failed = value !== null && typeof value === "object" && "exitCode" in value
    && typeof value.exitCode === "number" && value.exitCode !== 0;
  return { content, ...(failed ? { isError: true } : {}) };
}

/** Adapts the service catalog and client; all execution and ownership remain in Baseware. */
export async function createMcpServer(client: Pick<BasewareClient, "request">, inheritedEpoch = process.env.BASEWARE_EPOCH): Promise<McpServer> {
  const inheritedTrace = process.env.BASEWARE_TRACE ? z.record(z.string(), z.unknown()).parse(JSON.parse(process.env.BASEWARE_TRACE)) : {};
  const catalog = catalogSchema.parse(await client.request({ kind: "list", origin: "mcp" }));
  const server = new McpServer({ name: "baseware", version: "0.1.0" });
  const invoke = async (request: Request, signal: AbortSignal): Promise<CallToolResult> => {
    try {
      return await resultContent(await client.request({ ...request, origin: "mcp" }, signal), signal, request.kind === "sensor");
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  };

  for (const kind of ["list", "status"] as const) {
    server.registerTool(`baseware_${kind}`, {
      description: kind === "list" ? "Discover installed Baseware drivers, sensors, controllers, and their help." : "Read Baseware connection and control ownership status.",
      inputSchema: {}, annotations: { readOnlyHint: true },
    }, async (_args, { signal }) => invoke({ kind }, signal));
  }
  server.registerTool("baseware_help", {
    description: "Read a Baseware sensor or controller's argument documentation.",
    inputSchema: { id: z.string(), kind: z.enum(["sensor", "controller"]) },
    annotations: { readOnlyHint: true },
  }, async ({ id, kind }, { signal }) => invoke({ kind: "help", id, argv: [kind] }, signal));

  const names = new Set<string>();
  for (const kind of ["sensor", "controller"] as const) {
    for (const capability of kind === "sensor" ? catalog.sensors : catalog.controllers) {
      const name = `baseware_${kind}_${capability.id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
      names.add(name);
      server.registerTool(name, {
        description: capability.help,
        inputSchema: invocationSchema,
        annotations: { readOnlyHint: kind === "sensor" },
      }, async ({ argv, epoch }, { signal, requestId }) => invoke({
        kind, id: capability.id, argv, epoch: epoch ?? inheritedEpoch,
        trace: { ...inheritedTrace, toolCallId: String(requestId) },
      }, signal));
    }
  }
  return server;
}

/** The CLI's stdio entrypoint. stdout belongs exclusively to the official MCP transport. */
export async function startMcp(socket: string): Promise<McpServer> {
  let server: McpServer | undefined;
  const client = await BasewareClient.connect(socket, { onDisconnect: () => { void server?.close(); } });
  const ended = () => { void server?.close(); };
  try {
    server = await createMcpServer(client);
    server.server.onclose = () => {
      process.stdin.off("end", ended);
      client.close();
    };
    process.stdin.once("end", ended);
    await server.connect(new StdioServerTransport());
    return server;
  } catch (error) {
    process.stdin.off("end", ended);
    client.close();
    throw error;
  }
}
