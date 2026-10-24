import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { BasewareCore } from "../src/core.ts";
import { cuaCapabilities, listCuaTools } from "../src/drivers/cua/provider.ts";
import { archivedToolResult, argumentValidator } from "../src/tool-contract.ts";
import nativeDocs from "../contracts/cua-driver/macos-tools.json";
import portable from "../contracts/cua-driver/contract/manifest.json";

type CuaClient = Parameters<typeof cuaCapabilities>[0]["client"];
const clock = { id: "test", now: () => performance.now() };
const tool = (name: string, readOnlyHint?: boolean): Tool => ({
  name, description: `Upstream ${name}`, inputSchema: { type: "object", properties: { session: { type: "string" } } },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

test("Cua retains the full native catalog, schemas and metadata without a portable-contract whitelist", async () => {
  const calls: { name: string; arguments?: unknown }[] = [];
  const client = { async callTool(args) { calls.push(args); return { content: [] }; } } as CuaClient;
  const tools: Tool[] = nativeDocs.tools.map(entry => ({
    name: entry.name, description: entry.description, inputSchema: entry.input_schema as unknown as Tool["inputSchema"],
    annotations: { readOnlyHint: entry.read_only, destructiveHint: entry.destructive, idempotentHint: entry.idempotent },
  }));
  const futureTool: Tool = {
    name: "unfamiliar_future_tool", title: "A future native capability", description: "Not in the pinned snapshot",
    inputSchema: { type: "object", properties: { text: { type: "string" }, nested: { type: "array" } }, required: ["text"], additionalProperties: false },
    outputSchema: { type: "object", properties: { effect: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "cua/capabilities": ["future.operation"], "vendor/unknown": { keep: true } },
  };
  tools.push(futureTool);
  const capabilities = cuaCapabilities({ tools, client, artifactsDir: "/unused", clock });
  const core = new BasewareCore({ capabilities, drivers: [{ id: "cua", version: nativeDocs.version }] });
  const catalog = core.list().controllers;
  expect(nativeDocs.version).toBe("0.36.0");
  expect(nativeDocs.tools).toHaveLength(60);
  expect(portable.tools).toHaveLength(29);
  expect(catalog).toEqual(tools.map(tool => ({ ...tool, requiresControl: tool.annotations?.readOnlyHint !== true })));
  expect(catalog.some(tool => tool.name === "run_script")).toBe(true);
  expect(catalog.some(tool => tool.name === "browser_pointer")).toBe(true);
  expect(capabilities.controllers.at(-1)!.tool).toBe(futureTool);

  const args = { text: "$(touch untouched); --help 中文", nested: [1, false, { selector: "[name='A B']" }] };
  await core.execute(futureTool.name, args, undefined, new AbortController().signal);
  expect(calls).toEqual([{ name: "start_session", arguments: {} }, { name: futureTool.name, arguments: args }]);
  await expect(core.execute(futureTool.name, { wrong: true }, undefined, new AbortController().signal)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test("the complete macOS catalog compiles and its native schema constraints remain enforced", () => {
  const validators = new Map(nativeDocs.tools.map(entry => [entry.name, argumentValidator({
    name: entry.name, inputSchema: entry.input_schema as unknown as Tool["inputSchema"],
  })]));
  expect(validators.size).toBe(60);
  const drag = { from_x: 0, from_y: 0, to_x: 100, to_y: 100, duration_ms: 500, steps: 20 };
  expect(validators.get("drag")!(drag)).toBe(drag);
  for (const [name, args] of [
    ["drag", { ...drag, duration_ms: 10001 }],
    ["drag", { ...drag, steps: 0 }],
    ["drag", { ...drag, unknown: true }],
    ["drag", { ...drag, target: { kind: "window", pid: -1 } }],
    ["click", { element_token: "invalid" }],
    ["hotkey", { keys: ["cmd"] }],
    ["run_steps", { steps: [{ tool: "click", expect: [{}, {}, {}, {}, {}] }] }],
  ] as const) expect(() => validators.get(name)!(args)).toThrow();
  // This native schema intentionally permits additional fields.
  const browser = { target_id: "target", tab_id: "tab", session: "session", action: "hover", future: true };
  expect(validators.get("browser_pointer")!(browser)).toBe(browser);
});

test("a real MCP client roundtrip preserves native tool and content extensions at every depth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-cua-mcp-"));
  const definition = {
    ...tool("future_native_tool", true), vendorCapability: { nested: ["native"] },
    annotations: { readOnlyHint: true, vendorPolicy: { untouched: true } },
    _meta: { "native/tool": { value: 42 } },
  };
  const result = {
    content: [
      { type: "text" as const, text: "native output", vendorText: { untouched: true }, annotations: { audience: ["assistant" as const], vendorAnnotation: [1, 2] } },
      { type: "image" as const, data: Buffer.from("native image").toString("base64"), mimeType: "image/png", vendorImage: { frame: 4 } },
      { type: "resource" as const, vendorResource: true, resource: { uri: "memory://capture", mimeType: "application/octet-stream", blob: Buffer.from("native blob").toString("base64"), vendorEncoding: "native" } },
    ],
    structuredContent: { arbitrary: { sequence: [1, false, "three"] } },
    _meta: { "native/result": { untouched: true } }, vendorResult: { kept: true },
  };
  const server = new Server({ name: "native-cua-fixture", version: "0.36.0" }, { capabilities: { tools: {} } });
  const listCursors: (string | undefined)[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    listCursors.push(request.params?.cursor);
    return request.params?.cursor ? { tools: [definition] } : { tools: [tool("start_session", false)], nextCursor: "second" };
  });
  // Rust CUA emits native extensions directly; the JS Server subclass would
  // strip them before transmission, so register this fixture on its protocol.
  Protocol.prototype.setRequestHandler.call(server, CallToolRequestSchema,
    async request => request.params?.name === "start_session" ? { content: [] } : result);
  const client = new Client({ name: "baseware-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await listCuaTools(client);
    expect(listCursors).toEqual([undefined, "second"]);
    expect(tools[1]).toEqual(definition);
    const capabilities = cuaCapabilities({ tools, client, artifactsDir: directory, clock });
    const execution = await capabilities.controllers[1]!.execute({}, { signal: new AbortController().signal });
    expect(execution.result).toEqual(result);
    expect(execution.stdout).toBe("native output");
    expect(execution.observations!.map(observation => observation.contentIndex)).toEqual([1, 2]);
    const archived = archivedToolResult(execution.result, execution.observations);
    expect(archived).toMatchObject({ vendorResult: result.vendorResult, _meta: result._meta,
      content: [result.content[0], { vendorImage: { frame: 4 } }, { vendorResource: true, resource: { vendorEncoding: "native" } }] });
    expect(JSON.stringify(archived)).not.toContain(result.content[1]!.data!);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Cua persists binary media and preserves text, resources and structured output without duplicating payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-cua-media-"));
  const png = Buffer.from("fixture image"), audio = Buffer.from("fixture audio"), binary = Buffer.from("fixture resource");
  const result: CallToolResult = {
    _meta: { "cua/record": { id: "capture-42", untouched: true } },
    content: [
      { type: "text", text: "Window: Notes" },
      { type: "image", data: png.toString("base64"), mimeType: "image/png", annotations: { audience: ["assistant"] } },
      { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "memory://binary", mimeType: "application/octet-stream", blob: binary.toString("base64") } },
      { type: "resource", resource: { uri: "memory://tree", mimeType: "text/plain", text: "AXWindow > AXButton" } },
    ],
    structuredContent: { windowId: 42, tree: { role: "AXWindow", children: [{ role: "AXButton" }] } },
  };
  const client = { async callTool() { return result; } } as CuaClient;
  const { controllers } = cuaCapabilities({ tools: [tool("observe", true)], client, artifactsDir: directory, clock });
  try {
    const execution = await controllers[0]!.execute({}, { signal: new AbortController().signal });
    expect(execution).toMatchObject({ status: "completed", exitCode: 0 });
    expect(execution.result).toBe(result);
    expect(execution.stdout).toBe("Window: Notes");
    const archived = archivedToolResult(execution.result, execution.observations);
    expect(archived._meta).toEqual(result._meta);
    expect(archived.structuredContent).toEqual(result.structuredContent);
    expect((archived.content as CallToolResult["content"]).map(block => block.type)).toEqual(result.content.map(block => block.type));
    expect(JSON.stringify(archived)).not.toContain(png.toString("base64"));
    expect(execution.stdout).not.toContain(png.toString("base64"));
    expect(execution.stdout).not.toContain(audio.toString("base64"));
    expect(execution.stdout).not.toContain(binary.toString("base64"));
    expect(execution.observations!.map(item => item.mediaType)).toEqual(["image/png", "audio/wav", "application/octet-stream"]);
    const contents = await Promise.all(execution.observations!.map(item => readFile(item.path)));
    expect(contents).toEqual([png, audio, binary]);
    expect(new Set(execution.observations!.map(item => item.path)).size).toBe(3);
    expect(execution.observations!.map(item => item.contentIndex)).toEqual([1, 2, 3]);
    expect(execution.observations!.every(item => item.controllerId === "observe" && item.timing === execution.timing)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native screenshot file output stays intact and gets an immutable observation copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-cua-file-"));
  const source = join(directory, "latest.png");
  const bytes = Buffer.from("saved screenshot");
  await writeFile(source, bytes);
  const result: CallToolResult = { content: [{ type: "text", text: "desktop captured" }], structuredContent: {
    screenshot_file_path: source, screenshot_mime_type: "image/png", capture_id: "native-capture", screenshot_width: 400,
  } };
  const calls: { name: string; arguments?: unknown }[] = [];
  const client = { async callTool(args) { calls.push(args); return args.name === "start_session" ? { content: [] } : result; } } as CuaClient;
  const { controllers } = cuaCapabilities({ tools: [tool("get_desktop_state", true)], client, artifactsDir: directory, clock });
  try {
    const args = { screenshot_out_file: source };
    const execution = await controllers[0]!.execute(args, { signal: new AbortController().signal });
    expect(calls.at(-1)).toEqual({ name: "get_desktop_state", arguments: args });
    expect(execution.result).toBe(result);
    expect(execution.observations).toHaveLength(1);
    const observation = execution.observations![0]!;
    expect(observation.contentIndex).toBeUndefined();
    expect(observation.path).not.toBe(source);
    await writeFile(source, "next screenshot");
    expect(await readFile(observation.path)).toEqual(bytes);
    expect(execution.result.structuredContent!.screenshot_file_path).toBe(source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native refusal and unverifiable effect remain distinguishable from API completion", async () => {
  const refusal: CallToolResult = {
    isError: true, content: [{ type: "text", text: "Foreground delivery requires an explicit retry." }],
    structuredContent: { status: "refused", refusal: { code: "foreground_required", message: "Verify before retry" } },
    _meta: { "cua/native": true },
  };
  let native = refusal;
  const client = { async callTool(args) { return args.name === "start_session" ? { content: [] } : native; } } as CuaClient;
  const { controllers } = cuaCapabilities({ tools: [tool("click", false)], client, artifactsDir: "/unused", clock });
  const controller = controllers[0]!;
  const context = { signal: new AbortController().signal };
  const failed = await controller.execute({}, context);
  expect(failed).toMatchObject({ status: "failed", exitCode: 1, stdout: "", stderr: refusal.content[0]!.type === "text" ? refusal.content[0]!.text : "" });
  expect(failed.result).toBe(refusal);
  native = { content: [{ type: "text", text: "Input dispatched" }], structuredContent: { effect: "unverifiable", route: "synthetic_events" } };
  const completed = await controller.execute({}, context);
  expect(completed.status).toBe("completed");
  expect(completed.result).toBe(native);
  expect(completed.result.structuredContent!.effect).toBe("unverifiable");
});

test("the lease blocks Cua input, forwards cancellation, and revives ended sessions for the next takeover", async () => {
  const calls: { name: string; arguments?: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const active = new Set<string | undefined>();
  const started = Promise.withResolvers<AbortSignal>();
  const client = {
    async callTool(args, _schema, options) {
      calls.push({ ...args, signal: options?.signal });
      const session = typeof args.arguments?.session === "string" ? args.arguments.session : undefined;
      if (args.name === "start_session") active.add(session);
      else if (args.name === "end_session") active.delete(session);
      else if (!active.has(session)) throw new Error("session has ended");
      if (args.name === "click" && args.arguments?.wait) {
        const signal = options!.signal!;
        started.resolve(signal);
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return { content: [] };
    },
  } as CuaClient;
  const capabilities = cuaCapabilities({ tools: [tool("get_windows", true), tool("click", false), tool("type", false)],
    client, artifactsDir: "/unused", clock });
  const core = new BasewareCore({ capabilities, drivers: [{ id: "cua", version: "test" }] });
  const signal = new AbortController().signal;
  try {
    await expect(core.execute("click", {}, undefined, signal)).rejects.toThrow("STALE_EPOCH");
    expect(calls).toHaveLength(0);
    await core.execute("get_windows", {}, undefined, signal);
    await core.acquire("epoch", 30, { id: "owner" });
    await core.execute("type", { session: "second" }, "epoch", signal);
    const pending = core.execute("click", { session: "first", wait: true }, "epoch", signal);
    const forwarded = await started.promise;
    const rejected = pending.catch(error => error);
    await core.release("epoch");
    expect(await rejected).toBeInstanceOf(Error);
    expect(forwarded.aborted).toBe(true);
    expect(core.status()).toMatchObject({ mode: "manual", connected: true });
    const endings = calls.filter(call => call.name === "end_session");
    expect(endings.map(call => call.arguments)).toEqual([{}, { session: "second" }, { session: "first" }]);
    expect(endings.every(call => !call.signal?.aborted)).toBe(true);
    await core.release("epoch");
    expect(calls.filter(call => call.name === "end_session")).toHaveLength(3);
    expect(active.size).toBe(0);

    // Current CUA does not revive an ended implicit or named session by itself.
    // A second takeover must restart each session and retain it across calls.
    await core.acquire("next", 30, { id: "owner" });
    await core.execute("get_windows", {}, undefined, signal);
    await Promise.all([0, 1].map(() => core.execute("type", { session: "second" }, "next", signal)));
    const starts = calls.filter(call => call.name === "start_session");
    expect(starts.map(call => call.arguments)).toEqual([{}, { session: "second" }, { session: "first" }, {}, { session: "second" }]);
    expect(active.size).toBe(2);
    await core.release("next");
    expect(calls.filter(call => call.name === "end_session")).toHaveLength(5);
    expect(active.size).toBe(0);
  } finally { await core.close(); }
});
