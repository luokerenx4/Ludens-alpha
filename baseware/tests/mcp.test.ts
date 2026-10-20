import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BasewareClient } from "../src/client.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Envelope } from "../src/protocol.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const catalog = {
  drivers: [{ id: "fake-device", version: "1" }],
  controllers: [{ id: "pad", requiresControl: true, help: "tap <button> [--frames <count>]",
    commands: [{ name: "tap", parameters: { type: "object", properties: { button: { type: "string" } }, required: ["button"] },
      bindings: [{ parameter: "button", encoding: "string" }] }], stdoutSchema: { type: "object" } },
    { id: "screen", requiresControl: false, mediaTypes: ["image/png"], help: "capture --label <literal label>" }],
};

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
        if (request.argv?.[0] === "wait") { waiting.resolve(envelope); continue; }
        if (request.kind === "cancel") cancelled.resolve(envelope);
        if (request.epoch === "stale") {
          peer.write(JSON.stringify({ id, ok: false, error: "STALE_EPOCH" }) + "\n");
          continue;
        }
        const value = request.kind === "list" ? catalog
          : request.kind === "status" ? { mode: "manual" }
          : request.kind === "help" ? catalog.controllers[0]!.help
          : request.id === "screen" ? { id: "capture-1", status: "completed", exitCode: 0, stdout: "", stderr: "", observations: [{ id: "frame-1", controllerId: "screen", mediaType: "image/png", path: screenshot,
            timing: { clock: "fixture", requestedAtMs: 1, receivedAtMs: 2 } }] }
          : { id: "action-1", status: request.argv?.[0] === "fail" ? "failed" : "completed",
            exitCode: request.argv?.[0] === "fail" ? 1 : 0, stdout: "service result", stderr: "" };
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

test("MCP discovers service capabilities, validates argument arrays, and routes exact tokens and epochs", async () => {
  const f = await fixture();
  const mcp = await connected(f);
  try {
    const { tools } = await mcp.client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([
      "baseware_list", "baseware_status", "baseware_help", "baseware_controller_pad", "baseware_controller_screen",
    ]);
    expect(tools.find(tool => tool.name === "baseware_controller_pad")?.description).toBe(catalog.controllers[0]!.help);
    expect(tools.find(tool => tool.name === "baseware_controller_pad")?._meta).toEqual({
      "baseware/commands": catalog.controllers[0]!.commands, "baseware/stdoutSchema": catalog.controllers[0]!.stdoutSchema,
    });
    const discovered = await mcp.client.callTool({ name: "baseware_list", arguments: {} });
    expect(discovered.content).toEqual([{ type: "text", text: JSON.stringify(catalog) }]);
    const help = await mcp.client.callTool({ name: "baseware_help", arguments: { id: "pad" } });
    expect(help.content).toEqual([{ type: "text", text: catalog.controllers[0]!.help }]);
    const tokens = ["tap", "A B", "--frames", "0", "; echo untouched"];
    await mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: tokens } });
    expect(f.requests.at(-1)?.request).toMatchObject({ kind: "controller", id: "pad", argv: tokens, epoch: "inherited-epoch", origin: "mcp" });
    expect(f.requests.at(-1)?.request.trace?.toolCallId).toBeString();
    await mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: ["tap", "B"], epoch: "explicit-epoch" } });
    expect(f.requests.at(-1)?.request.epoch).toBe("explicit-epoch");
    const before = f.requests.length;
    const invalid = await mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: "tap A" } });
    expect(invalid.isError).toBe(true);
    expect(f.requests.length).toBe(before);
    expect(f.requests.some(({ request }) => request.kind === "acquire")).toBe(false);
  } finally { await mcp.close(); await f.close(); }
});

test("MCP returns service images and reports service and execution errors", async () => {
  const f = await fixture();
  const mcp = await connected(f);
  try {
    const result = await mcp.client.callTool({ name: "baseware_controller_screen", arguments: { argv: ["capture"] } });
    expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    const stale = await mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: ["tap", "A"], epoch: "stale" } });
    expect(stale).toMatchObject({ isError: true, content: [{ type: "text", text: "STALE_EPOCH" }] });
    const failed = await mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: ["fail"] } });
    expect(failed.isError).toBe(true);
  } finally { await mcp.close(); await f.close(); }
});

test("MCP cancellation reaches the same Baseware wire request", async () => {
  const f = await fixture();
  const mcp = await connected(f);
  try {
    const controller = new AbortController();
    const pending = mcp.client.callTool({ name: "baseware_controller_pad", arguments: { argv: ["wait"] } }, undefined, { signal: controller.signal });
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
    expect((await client.listTools()).tools.some(tool => tool.name === "baseware_controller_screen")).toBe(true);
    await client.callTool({ name: "baseware_controller_pad", arguments: { argv: ["tap", "A"] } });
    expect(f.requests.at(-1)?.request.epoch).toBe("stdio-epoch");
    expect(f.requests.at(-1)?.request.trace?.runId).toBe("parent-run");
    expect(f.requests.at(-1)?.request.trace?.toolCallId).not.toBe("parent-call");
    expect(f.requests.some(({ request }) => request.kind === "acquire")).toBe(false);
  } finally { await client.close(); await f.close(); }
});
