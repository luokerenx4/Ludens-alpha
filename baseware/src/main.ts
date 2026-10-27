#!/usr/bin/env bun
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { cli, HELP } from "./cli.ts";
import { defaultSocket } from "./address.ts";
import { BasewareCore } from "./core.ts";
import type { Capabilities } from "./contracts.ts";
import { EventLog } from "./events.ts";
import { listen } from "./server.ts";
import { createGbaProvider } from "./drivers/mgba/provider.ts";
import { createSwitchProvider } from "./drivers/ryubing/provider.ts";
import { createCuaProvider } from "./drivers/cua/provider.ts";
import { createAzaharProvider } from "./drivers/azahar/provider.ts";

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "--help") { console.log(HELP); return; }
  const socket = process.env.BASEWARE_SOCKET ?? await defaultSocket();
  if (args[0] === "mcp") { const { startMcp } = await import("./mcp.ts"); return startMcp(socket); }
  if (args[0] !== "serve") return cli(args, socket);
  const { values } = parseArgs({ args: args.slice(1), options: {
    driver: { type: "string", default: "mgba" }, port: { type: "string" },
    socket: { type: "string", default: socket }, "data-dir": { type: "string" },
    "cua-command": { type: "string" },
  } });
  if (!["mgba", "ryubing", "azahar", "cua"].includes(values.driver!)) throw new Error("--driver must be mgba, ryubing, azahar or cua");
  if (values["cua-command"] && values.driver !== "cua") throw new Error("--cua-command is only for the cua driver");
  const port = values.driver === "cua" ? undefined : Number(values.port ?? (values.driver === "mgba" ? 47653 : values.driver === "azahar" ? 47673 : 47663));
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--port must be between 1 and 65535");
  const dataDir = resolve(values["data-dir"] ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "playness/baseware", basename(values.socket!, ".sock")));
  let core: BasewareCore | undefined;
  let provider: { capabilities: Capabilities; version?: string;
    onDisconnect(handler: (error: Error) => void): void; close(): void | Promise<void> } | undefined;
  // Claim the address before touching a device; a second service must fail immediately.
  const closeServer = await listen(values.socket!, () => {
    if (!core) throw new Error("Baseware is starting");
    return core;
  });
  try {
    const serviceId = crypto.randomUUID();
    const clock = { id: serviceId, now: () => performance.now() };
    const log = new EventLog(dataDir);
    provider = values.driver === "cua"
      ? await createCuaProvider({ command: values["cua-command"], clock })
      : values.driver === "azahar"
      ? await createAzaharProvider({ port: port!, clock })
      : await (values.driver === "mgba" ? createGbaProvider : createSwitchProvider)({ port: port!, clock });
    core = new BasewareCore({ capabilities: provider.capabilities, record: log.record, serviceId,
      drivers: [{ id: values.driver!, version: provider.version ?? (values.driver === "mgba" ? "0.10.5" : "1.3.351-rsa.3") }] });
    provider.onDisconnect(error => { void core!.disconnected(error); });
    core.record("service_start", { driver: values.driver, ...(port !== undefined ? { port } : {}), socket: values.socket, dataDir });
    console.log(JSON.stringify({ ready: true, socket: values.socket, dataDir, ...core.status() }));
    await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } finally {
    await closeServer();
    await provider?.close();
    core?.record("service_end", core.status());
  }
}

if (import.meta.main) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
