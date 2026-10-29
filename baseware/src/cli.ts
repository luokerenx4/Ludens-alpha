import { readToolArguments } from "./tool-contract.ts";
import { BasewareClient } from "./client.ts";
import { writeCapabilityDocument } from "./catalog.ts";
import type { Catalog, Request } from "./protocol.ts";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const HELP = `baseware serve --driver mgba|ryubing|azahar|cua [--driver-package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>] [--port <n>] [--cua-command <path>] [--socket <path>] [--data-dir <path>] [--diagnostics normal|full]
baseware status
baseware list
baseware export [--output <path>]
baseware driver list
baseware driver discover --package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>
baseware controller list | <id> --help | <name> [--args '<JSON object>' | --file <arguments.json>]
baseware revoke
baseware mcp

BASEWARE_SOCKET selects the service. Its default address is derived from the current directory.
export writes the live capability and invocation contract to ./baseware.json by default.
Controllers marked requiresControl require BASEWARE_EPOCH from an existing owner connection.
The CLI never acquires a lease; use the client API to hold a persistent owner connection.`;

export async function cli(argv: string[], socket: string) {
  const [kind, id, ...args] = argv;
  if (kind === "driver" && id === "discover") {
    const { values } = parseArgs({ args, options: { package: { type: "string" } } });
    if (!values.package) throw new Error("Usage: baseware driver discover --package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>");
    // CLI plugin probe; the spec-selected entrypoint is only known at runtime.
    const { defaultDriverCacheRoot, discoverDriver } = await import("./drivers/loader.ts");
    const registration = await discoverDriver(values.package, defaultDriverCacheRoot());
    const { id: driverId, version, fallbackVersion, transport, defaultPort, needsGame, launchHint, launchCommand, launchEnv } = registration;
    console.log(JSON.stringify({ id: driverId, version: version ?? fallbackVersion ?? "unknown",
      ...(transport ? { transport } : {}),
      ...(defaultPort !== undefined ? { defaultPort } : {}),
      ...(needsGame ? { needsGame: true } : {}),
      ...(launchHint ? { launchHint } : {}),
      ...(launchCommand ? { launchCommand } : {}),
      ...(launchEnv ? { launchEnv } : {}) }));
    return;
  }
  let request: Request;
  let output: string | undefined;
  let select: "drivers" | "controllers" | undefined;
  if (kind === "export") {
    const { values } = parseArgs({ args: argv.slice(1), options: { output: { type: "string", default: "baseware.json" } } });
    output = resolve(values.output!);
    request = { kind: "list" };
  } else if (kind === "status" || kind === "revoke" || kind === "list") {
    if (argv.length !== 1) throw new Error(`Usage: baseware ${kind}`);
    request = { kind };
  } else if (["driver", "controller"].includes(kind!)) {
    if (id === "list" && !args.length) {
      select = kind === "driver" ? "drivers" : "controllers";
      request = { kind: "list" };
    } else if (kind === "controller" && id) {
      request = args.length === 1 && args[0] === "--help"
        ? { kind: "help", id }
        : { kind, id, arguments: await readToolArguments(args), epoch: process.env.BASEWARE_EPOCH,
          trace: process.env.BASEWARE_TRACE ? JSON.parse(process.env.BASEWARE_TRACE) : undefined, origin: "cli" };
    } else throw new Error("Missing capability ID; see baseware --help");
  } else if (kind === "help" && id) request = { kind: "help", id };
  else throw new Error("Unknown command; see baseware --help");
  const client = await BasewareClient.connect(socket);
  try {
    let value = await client.request(request);
    if (output) {
      await writeCapabilityDocument(value as Catalog, output);
      console.log(output);
      return output;
    }
    if (select) value = (value as Record<string, unknown>)[select];
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    if (value && typeof value === "object" && "exitCode" in value) process.exitCode = Number(value.exitCode);
    return value;
  } finally { client.close(); }
}
