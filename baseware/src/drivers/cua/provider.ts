import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Capabilities, Clock, Controller, ExecutionResult, Observation } from "../../contracts.ts";

const REQUEST_TIMEOUT = 2_147_483_647;
type CuaClient = Pick<Client, "callTool">;

function argumentsFrom(argv: readonly string[]): Record<string, unknown> {
  if (!argv.length) return {};
  if (argv.length !== 2 || argv[0] !== "--args") throw new Error("Usage: --args '<JSON object>'");
  const value = JSON.parse(argv[1]!);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--args must be a JSON object");
  return value;
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
          undefined, { signal, timeout: REQUEST_TIMEOUT });
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
        undefined, { timeout: REQUEST_TIMEOUT });
    }));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (outcome.value.isError) throw new Error(JSON.stringify(outcome.value.content));
    }
  };
  const controllers: Controller[] = options.tools.map(tool => ({
    id: `cua.${tool.name}`,
    requiresControl: tool.annotations?.readOnlyHint !== true,
    acquire, release,
    help: () => `${tool.description ?? tool.name}\n--args '<JSON object>' (omit for no arguments)\n${JSON.stringify(tool.inputSchema)}\nCalls the installed Cua Driver. Session state is retained across calls and ended when control is returned.`,
    async execute(argv, { signal }): Promise<ExecutionResult> {
      signal.throwIfAborted();
      const args = argumentsFrom(argv);
      const session = typeof args.session === "string" ? args.session : undefined;
      const requestedAtMs = clock.now();
      // An ended implicit session also needs explicit revival in current CUA releases.
      if (tool.name !== "start_session" && tool.name !== "end_session") await startSession(session, signal);
      signal.throwIfAborted();
      const pending = client.callTool({ name: tool.name, arguments: args }, undefined, {
        signal, timeout: REQUEST_TIMEOUT,
      });
      if (tool.name === "start_session") {
        const started = pending.then(result => { if (result.isError) throw new Error(JSON.stringify(result.content)); });
        sessions.set(session, started);
        void started.catch(() => { if (sessions.get(session) === started) sessions.delete(session); });
      }
      const result = await pending as CallToolResult;
      if (tool.name === "end_session" && !result.isError) sessions.delete(session);
      const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
      const observations: Observation[] = [];
      const content: CallToolResult["content"] = [];
      for (const block of result.content) {
        const payload = block.type === "image" || block.type === "audio" ? block
          : block.type === "resource" && "blob" in block.resource ? {
            data: block.resource.blob, mimeType: block.resource.mimeType ?? "application/octet-stream",
          } : undefined;
        if (!payload) { content.push(block); continue; }
        const id = crypto.randomUUID();
        const suffix = payload.mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
        const path = join(options.artifactsDir, `${id}.${suffix}`);
        await writeFile(path, Buffer.from(payload.data, "base64"));
        observations.push({ id, controllerId: `cua.${tool.name}`, mediaType: payload.mimeType, path, timing });
      }
      // Keep the upstream text and structured result, but never duplicate binary media in logs.
      const output = { content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
      return { id: crypto.randomUUID(), status: result.isError ? "failed" : "completed",
        exitCode: result.isError ? 1 : 0, stdout: JSON.stringify(output),
        stderr: result.isError ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "",
        timing, ...(observations.length ? { observations } : {}) };
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
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      capabilities: cuaCapabilities({ ...options, tools, client }),
      version: client.getServerVersion()?.version ?? "unknown",
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; },
      async close() { closed = true; await client.close(); },
    };
  } catch (error) { closed = true; await client.close(); throw error; }
}
