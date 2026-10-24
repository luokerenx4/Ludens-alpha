import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Capabilities, Clock, Controller, Observation } from "../../contracts.ts";
import { objectArguments, toolExecution } from "../../tool-contract.ts";

const REQUEST_TIMEOUT = 2_147_483_647;
type CuaClient = Pick<Client, "callTool">;

// SDK object schemas validate the standard fields but strip native extensions.
// Validate with those schemas, then retain the original value at every depth.
const nativeToolsSchema = z.custom<ListToolsResult>(value => ListToolsResultSchema.safeParse(value).success);
const nativeResultSchema = z.custom<CallToolResult>(value => {
  const checked = CallToolResultSchema.safeParse(value);
  return checked.success && Array.isArray((value as CallToolResult).content);
}) as unknown as typeof CallToolResultSchema; // callTool types only admit the SDK's concrete schema type.

export async function listCuaTools(client: Pick<Client, "request">): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request({ method: "tools/list", params: { cursor } }, nativeToolsSchema);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Keep upstream tools and schemas intact; Baseware owns admission and the transport session. */
export function cuaCapabilities(options: { tools: Tool[]; client: CuaClient; artifactsDir: string; clock: Clock }) {
  const { client, clock } = options;
  const sessions = new Map<string | undefined, Promise<void>>();
  let owner: string | undefined;
  const acquire = async (epoch: string) => { owner = epoch; };
  const startSession = (session: string | undefined, signal: AbortSignal) => {
    let pending = sessions.get(session);
    if (!pending) {
      pending = (async () => {
        const result = await client.callTool({ name: "start_session", arguments: session === undefined ? {} : { session } },
          nativeResultSchema, { signal, timeout: REQUEST_TIMEOUT });
        if (result.isError) throw new Error(JSON.stringify(result.content));
      })();
      sessions.set(session, pending);
      void pending.catch(() => { if (sessions.get(session) === pending) sessions.delete(session); });
    }
    return pending;
  };
  const release = async (epoch: string) => {
    if (owner !== epoch) return;
    owner = undefined;
    const ending = [...sessions];
    sessions.clear();
    // CUA owns native input cleanup. End all sessions used by this private connection.
    const outcomes = await Promise.allSettled(ending.map(async ([session, started]) => {
      await started.catch(() => {});
      return client.callTool({ name: "end_session", arguments: session === undefined ? {} : { session } },
        nativeResultSchema, { timeout: REQUEST_TIMEOUT });
    }));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (outcome.value.isError) throw new Error(JSON.stringify(outcome.value.content));
    }
  };
  const controllers: Controller[] = options.tools.map(tool => ({
    tool,
    requiresControl: tool.annotations?.readOnlyHint !== true,
    acquire, release,
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const args = objectArguments(input);
      const session = typeof args.session === "string" ? args.session : undefined;
      const requestedAtMs = clock.now();
      // An ended implicit session also needs explicit revival in current CUA releases.
      if (tool.name !== "start_session" && tool.name !== "end_session") await startSession(session, signal);
      signal.throwIfAborted();
      const pending = client.callTool({ name: tool.name, arguments: args }, nativeResultSchema, {
        signal, timeout: REQUEST_TIMEOUT,
      });
      if (tool.name === "start_session") {
        const started = pending.then(result => { if (result.isError) throw new Error(JSON.stringify(result.content)); });
        sessions.set(session, started);
        void started.catch(() => { if (sessions.get(session) === started) sessions.delete(session); });
      }
      const result = await pending as CallToolResult;
      if (tool.name === "end_session" && !result.isError) sessions.delete(session);
      const execution = toolExecution(clock, requestedAtMs, result);
      const observations: Observation[] = [];
      const archive = async (data: Buffer, mediaType: string, contentIndex?: number) => {
        const id = crypto.randomUUID();
        const suffix = mediaType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
        const path = join(options.artifactsDir, `${id}.${suffix}`);
        await writeFile(path, data);
        observations.push({ id, controllerId: tool.name, mediaType, path, timing: execution.timing,
          ...(contentIndex === undefined ? {} : { contentIndex }) });
      };
      for (const [index, block] of result.content.entries()) {
        const payload = block.type === "image" || block.type === "audio" ? block
          : block.type === "resource" && "blob" in block.resource ? {
            data: block.resource.blob, mimeType: block.resource.mimeType ?? "application/octet-stream",
          } : undefined;
        if (payload) await archive(Buffer.from(payload.data, "base64"), payload.mimeType, index);
      }
      // Native screenshot_out_file returns a path instead of an image block. Keep
      // that payload intact and archive a copy before the next capture overwrites it.
      const screenshot = result.structuredContent?.screenshot_file_path;
      if (!result.isError && typeof screenshot === "string") {
        const mediaType = typeof result.structuredContent?.screenshot_mime_type === "string"
          ? result.structuredContent.screenshot_mime_type : "image/png";
        await archive(await readFile(screenshot), mediaType);
      }
      return { ...execution, ...(observations.length ? { observations } : {}) };
    },
  }));
  return { controllers } satisfies Capabilities;
}

export async function createCuaProvider(options: { command?: string; artifactsDir: string; clock: Clock }) {
  await mkdir(options.artifactsDir, { recursive: true });
  const transport = new StdioClientTransport({ command: options.command ?? "cua-driver", args: ["mcp"] });
  const client = new Client({ name: "playness-baseware", version: "0.1.0" }, { capabilities: {} });
  let onDisconnect: ((error: Error) => void) | undefined;
  let closed = false;
  client.onclose = () => { if (!closed) onDisconnect?.(new Error("Cua Driver connection closed")); };
  try {
    await client.connect(transport);
    const tools = await listCuaTools(client);
    return {
      capabilities: cuaCapabilities({ ...options, tools, client }),
      version: client.getServerVersion()?.version ?? "unknown",
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; },
      async close() { closed = true; await client.close(); },
    };
  } catch (error) { closed = true; await client.close(); throw error; }
}
