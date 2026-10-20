import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { BasewareCore } from "../src/core.ts";
import { cuaCapabilities } from "../src/drivers/cua/provider.ts";

type CuaClient = Parameters<typeof cuaCapabilities>[0]["client"];
const clock = { id: "test", now: () => performance.now() };
const tool = (name: string, readOnlyHint?: boolean): Tool => ({
  name, description: `Upstream ${name}`, inputSchema: { type: "object", properties: { session: { type: "string" } } },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

test("Cua exposes the complete upstream catalog and forwards literal JSON arguments", async () => {
  const calls: { name: string; arguments?: unknown }[] = [];
  const client = { async callTool(args) { calls.push(args); return { content: [] }; } } as CuaClient;
  const tools = [tool("get_windows", true), {
    ...tool("click", false),
    inputSchema: { type: "object" as const, properties: {
      x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
      target: { oneOf: [{ type: "string" }, { type: "object", properties: { windowId: { type: "number" } } }] },
    }, required: ["x", "y"], additionalProperties: false },
    outputSchema: { type: "object" as const, properties: { clicked: { type: "boolean" } }, required: ["clicked"] },
  }, tool("unfamiliar_future_tool")];
  const capabilities = cuaCapabilities({ tools, client, artifactsDir: "/unused", clock });
  const core = new BasewareCore({ capabilities, drivers: [{ id: "cua", version: "test" }] });
  const catalog = core.list().controllers;
  expect(catalog.map(({ id, requiresControl }) => ({ id, requiresControl }))).toEqual([
    { id: "cua.get_windows", requiresControl: false },
    { id: "cua.click", requiresControl: true },
    { id: "cua.unfamiliar_future_tool", requiresControl: true },
  ]);
  expect(catalog[0]!.commands).toEqual([{
    name: "", description: expect.any(String),
    parameters: { type: "object", properties: { args: tools[0]!.inputSchema }, additionalProperties: false },
    bindings: [{ parameter: "args", flag: "--args", encoding: "json" }],
  }]);
  expect(catalog[1]!.commands![0]!.parameters).toEqual({
    type: "object", properties: { args: tools[1]!.inputSchema }, additionalProperties: false, required: ["args"],
  });
  expect(catalog[0]!.stdoutSchema).toBeUndefined();
  expect(catalog[1]!.stdoutSchema).toEqual({
    type: "object", description: expect.any(String),
    properties: { content: { type: "array" }, structuredContent: tools[1]!.outputSchema }, required: ["content"],
  });
  expect(catalog[2]!.help).toContain(JSON.stringify(tools[2]!.inputSchema));
  const args = { session: "one", selector: "[name='A B']", text: "$(touch untouched); --help", nested: [1, false] };
  await core.execute("cua.get_windows", ["--args", JSON.stringify(args)], undefined, new AbortController().signal);
  expect(calls).toEqual([{ name: "start_session", arguments: { session: "one" } }, { name: "get_windows", arguments: args }]);
  await expect(core.execute("cua.get_windows", ["--args", "[]"], undefined, new AbortController().signal))
    .rejects.toThrow("JSON object");
  expect(calls).toHaveLength(2);
  await core.execute("cua.get_windows", [], undefined, new AbortController().signal);
  expect(calls.slice(-2)).toEqual([{ name: "start_session", arguments: {} }, { name: "get_windows", arguments: {} }]);
});

test("Cua persists binary media and preserves text, resources and structured output without duplicating payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-cua-media-"));
  const png = Buffer.from("fixture image"), audio = Buffer.from("fixture audio"), binary = Buffer.from("fixture resource");
  const result: CallToolResult = {
    content: [
      { type: "text", text: "Window: Notes" },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "memory://binary", mimeType: "application/octet-stream", blob: binary.toString("base64") } },
      { type: "resource", resource: { uri: "memory://tree", mimeType: "text/plain", text: "AXWindow > AXButton" } },
    ],
    structuredContent: { windowId: 42, tree: { role: "AXWindow", children: [{ role: "AXButton" }] } },
  };
  const client = { async callTool() { return result; } } as CuaClient;
  const { controllers } = cuaCapabilities({ tools: [tool("observe", true)], client, artifactsDir: directory, clock });
  try {
    const execution = await controllers[0]!.execute([], { signal: new AbortController().signal });
    expect(execution).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(execution.stdout)).toEqual({ content: [result.content[0], result.content[4]], structuredContent: result.structuredContent });
    expect(execution.stdout).not.toContain(png.toString("base64"));
    expect(execution.stdout).not.toContain(audio.toString("base64"));
    expect(execution.stdout).not.toContain(binary.toString("base64"));
    expect(execution.observations!.map(item => item.mediaType)).toEqual(["image/png", "audio/wav", "application/octet-stream"]);
    const contents = await Promise.all(execution.observations!.map(item => readFile(item.path)));
    expect(contents).toEqual([png, audio, binary]);
    expect(new Set(execution.observations!.map(item => item.path)).size).toBe(3);
    expect(execution.observations!.every(item => item.controllerId === "cua.observe" && item.timing === execution.timing)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
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
    await expect(core.execute("cua.click", [], undefined, signal)).rejects.toThrow("STALE_EPOCH");
    expect(calls).toHaveLength(0);
    await core.execute("cua.get_windows", [], undefined, signal);
    await core.acquire("epoch", 30, { id: "owner" });
    await core.execute("cua.type", ["--args", '{"session":"second"}'], "epoch", signal);
    const pending = core.execute("cua.click", ["--args", '{"session":"first","wait":true}'], "epoch", signal);
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
    await core.execute("cua.get_windows", [], undefined, signal);
    await Promise.all([0, 1].map(() => core.execute("cua.type", ["--args", '{"session":"second"}'], "next", signal)));
    const starts = calls.filter(call => call.name === "start_session");
    expect(starts.map(call => call.arguments)).toEqual([{}, { session: "second" }, { session: "first" }, {}, { session: "second" }]);
    expect(active.size).toBe(2);
    await core.release("next");
    expect(calls.filter(call => call.name === "end_session")).toHaveLength(5);
    expect(active.size).toBe(0);
  } finally { await core.close(); }
});
