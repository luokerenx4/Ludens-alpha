import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { BasewareClient } from "../src/client.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "../src/protocol.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const catalog = {
  drivers: [{ id: "fake-device", version: "1" }],
  controllers: [{ name: "native_action", requiresControl: true, description: "Native action contract",
    inputSchema: { type: "object", properties: { mode: { type: "string" }, keys: { type: "array", items: { type: "string" } } }, required: ["mode"], additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } }, annotations: { readOnlyHint: false, idempotentHint: false, vendorPolicy: { retained: true } }, _meta: { "native/version": "1" }, vendorCapability: { retained: true } },
    { name: "native_screen", requiresControl: false, mediaTypes: ["image/png"], description: "Native screenshot",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }],
};
const nativeImage = { content: [{ type: "image" as const, mimeType: "image/png", data: png.toString("base64"), annotations: { audience: ["user" as const], vendorAnnotation: { retained: true } }, vendorImage: { sequence: 5 } }],
  _meta: { source: "native" }, vendorResult: { retained: true } };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baseware-mcp-"));
  const socket = join(directory, "service.sock");
  const screenshot = join(directory, "screen.png");
  await writeFile(screenshot, png);
  const requests: Envelope[] = [];
  const waiting = Promise.withResolvers<Envelope>();
  const cancelled = Promise.withResolvers<Envelope>();
  const peers = new Set<Socket>();
  const service = createServer(peer => {
    peers.add(peer);
    peer.on("close", () => peers.delete(peer));
    peer.setEncoding("utf8");
    let buffer = "";
    peer.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const envelope: Envelope = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(envelope);
        const { request, id } = envelope;
        if (request.arguments?.mode === "wait") { waiting.resolve(envelope); continue; }
        if (request.kind === "cancel") cancelled.resolve(envelope);
        if (request.epoch === "stale") {
          peer.write(JSON.stringify({ id, ok: false, error: "STALE_EPOCH" }) + "\n");
          continue;
        }
        const value = request.kind === "list" ? catalog
          : request.kind === "status" ? { mode: "manual" }
          : request.kind === "help" ? catalog.controllers[0]!.description
          : request.id === "native_screen" ? { result: nativeImage, id: "capture-1", status: "completed", exitCode: 0, stdout: "", stderr: "", observations: [{ id: "frame-1", controllerId: "screen", mediaType: "image/png", path: screenshot,
            timing: { clock: "fixture", requestedAtMs: 1, receivedAtMs: 2 } }] }
          : { result: { content: [{ type: "text", text: "service result" }], structuredContent: { ok: request.arguments?.mode !== "fail" }, ...(request.arguments?.mode === "fail" ? { isError: true } : {}) }, id: "action-1", status: request.arguments?.mode === "fail" ? "failed" : "completed",
            exitCode: request.arguments?.mode === "fail" ? 1 : 0, stdout: "service result", stderr: "" };
        peer.write(JSON.stringify({ id, ok: true, value }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { service.once("error", reject); service.listen(socket, resolve); });
  return {
    socket, requests, waiting: waiting.promise, cancelled: cancelled.promise,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => service.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function connected(f: Awaited<ReturnType<typeof fixture>>, epoch = "inherited-epoch") {
  const baseware = await BasewareClient.connect(f.socket);
  const server = await createMcpServer(baseware, epoch);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, async close() { await client.close(); await server.close(); baseware.close(); } };
}

test("MCP exposes exact native definitions, validates object arguments and returns native results", async () => {
  const f = await fixture();
  const mcp = await connected(f);
  try {
    // Inspect the actual payload; high-level SDK helpers strip unknown fields.
    const { tools } = await mcp.client.request({ method: "tools/list" }, z.custom<{ tools: unknown[] }>(() => true));
    expect(tools).toEqual(catalog.controllers.map(({ requiresControl, mediaTypes, ...tool }: any) => tool));
    const args = { mode: "tap", keys: ["A B", "; echo untouched"] };
    const result = await mcp.client.callTool({ name: "native_action", arguments: args });
    expect(result).toEqual({ content: [{ type: "text", text: "service result" }], structuredContent: { ok: true } });
    expect(f.requests.at(-1)?.request).toMatchObject({ kind: "controller", id: "native_action", arguments: args, epoch: "inherited-epoch", origin: "mcp" });
    expect(f.requests.at(-1)?.request.trace?.toolCallId).toBeString();
    const before = f.requests.length;
    const invalid = await mcp.client.callTool({ name: "native_action", arguments: { mode: "tap", keys: "A" } });
    expect(invalid.isError).toBe(true);
    expect(f.requests.length).toBe(before);
    const image = await mcp.client.request({ method: "tools/call", params: { name: "native_screen", arguments: {} } }, z.custom<CallToolResult>(() => true));
    expect(image).toEqual(nativeImage);
    const failed = await mcp.client.callTool({ name: "native_action", arguments: { mode: "fail" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false } });
    expect(f.requests.some(({ request }) => request.kind === "acquire")).toBe(false);
  } finally { await mcp.close(); await f.close(); }
});

test("MCP reports service rejection without changing native argument schema to accept epochs", async () => {
  const f = await fixture();
  const mcp = await connected(f, "stale");
  try {
    const result = await mcp.client.callTool({ name: "native_action", arguments: { mode: "tap" } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "STALE_EPOCH" }] });
  } finally { await mcp.close(); await f.close(); }
});

test("MCP cancellation reaches the same Baseware wire request", async () => {
  const f = await fixture();
  const mcp = await connected(f);
  try {
    const controller = new AbortController();
    const pending = mcp.client.callTool({ name: "native_action", arguments: { mode: "wait" } }, undefined, { signal: controller.signal });
    const operation = await f.waiting;
    controller.abort(new Error("test cancellation"));
    await expect(pending).rejects.toThrow("test cancellation");
    expect((await f.cancelled).request).toEqual({ kind: "cancel", operationId: operation.id });
  } finally { await mcp.close(); await f.close(); }
});

test("stdio entrypoint speaks SDK MCP and inherits epoch and trace without acquiring", async () => {
  const f = await fixture();
  const modulePath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", `const { startMcp } = await import(${JSON.stringify(modulePath)}); await startMcp(${JSON.stringify(f.socket)});`],
    env: { BASEWARE_EPOCH: "stdio-epoch", BASEWARE_TRACE: JSON.stringify({ runId: "parent-run", toolCallId: "parent-call" }) }, stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === "native_screen")).toBe(true);
    await client.callTool({ name: "native_action", arguments: { mode: "tap", keys: ["A"] } });
    expect(f.requests.at(-1)?.request.epoch).toBe("stdio-epoch");
    expect(f.requests.at(-1)?.request.trace?.runId).toBe("parent-run");
    expect(f.requests.at(-1)?.request.trace?.toolCallId).not.toBe("parent-call");
    expect(f.requests.some(({ request }) => request.kind === "acquire")).toBe(false);
  } finally { await client.close(); await f.close(); }
});
