import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BasewareClient } from "./client.ts";
import { argumentValidator, objectArguments } from "./tool-contract.ts";
import type { ToolExecutionResult } from "./contracts.ts";
import type { Catalog } from "./protocol.ts";

/** Raw MCP schemas/results are retained; rebuilding them through a second DSL loses native fields. */
export async function createMcpServer(client: Pick<BasewareClient, "request">, inheritedEpoch = process.env.BASEWARE_EPOCH): Promise<Server> {
  const inheritedTrace = process.env.BASEWARE_TRACE ? objectArguments(JSON.parse(process.env.BASEWARE_TRACE)) : {};
  const catalog = await client.request({ kind: "list", origin: "mcp" }) as Catalog;
  const tools = catalog.controllers.map(({ requiresControl: _control, mediaTypes: _media, ...tool }) => tool);
  const validators = new Map(tools.map(tool => [tool.name, argumentValidator(tool)]));
  if (validators.size !== tools.length) throw new Error("Duplicate MCP tool name");
  const server = new Server({ name: "baseware", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  // Server.setRequestHandler parses results into stripped SDK objects. Register
  // on the official protocol so validation can retain native extension fields.
  Protocol.prototype.setRequestHandler.call(server, CallToolRequestSchema, async (request, { signal, requestId }): Promise<CallToolResult> => {
    try {
      const { params } = CallToolRequestSchema.parse(request);
      const validate = validators.get(params.name);
      if (!validate) throw new Error(`Unknown controller: ${params.name}`);
      const result = await client.request({ kind: "controller", id: params.name,
        arguments: validate(params.arguments ?? {}), epoch: inheritedEpoch, origin: "mcp",
        trace: { ...inheritedTrace, toolCallId: String(requestId) } }, signal) as ToolExecutionResult;
      CallToolResultSchema.parse(result.result);
      return result.result;
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}

/** stdout belongs exclusively to the official MCP transport. This connection does not acquire control. */
export async function startMcp(socket: string): Promise<Server> {
  let server: Server | undefined;
  const client = await BasewareClient.connect(socket, { onDisconnect: () => { void server?.close(); } });
  const ended = () => { void server?.close(); };
  try {
    server = await createMcpServer(client);
    server.onclose = () => { process.stdin.off("end", ended); client.close(); };
    process.stdin.once("end", ended);
    await server.connect(new StdioServerTransport());
    return server;
  } catch (error) {
    process.stdin.off("end", ended);
    client.close();
    throw error;
  }
}
