import { BasewareClient } from "./client.ts";
import type { Request } from "./protocol.ts";

export const HELP = `baseware serve --driver mgba|ryubing|cua [--port <n>] [--cua-command <path>] [--socket <path>] [--data-dir <path>]
baseware status
baseware list
baseware driver list
baseware controller list | <id> --help | <id> <arguments...>
baseware revoke
baseware mcp

BASEWARE_SOCKET selects the service. Its default address is derived from the current directory.
Controllers marked requiresControl require BASEWARE_EPOCH from an existing owner connection.
The CLI never acquires a lease; use the client API to hold a persistent owner connection.`;

export async function cli(argv: string[], socket: string) {
  const [kind, id, ...args] = argv;
  let request: Request;
  let select: "drivers" | "controllers" | undefined;
  if (kind === "status" || kind === "revoke" || kind === "list") {
    if (argv.length !== 1) throw new Error(`Usage: baseware ${kind}`);
    request = { kind };
  } else if (["driver", "controller"].includes(kind!)) {
    if (id === "list" && !args.length) {
      select = kind === "driver" ? "drivers" : "controllers";
      request = { kind: "list" };
    } else if (kind === "controller" && id) {
      request = args.length >= 1 && args.length <= 2 && args.at(-1) === "--help"
        ? { kind: "help", id }
        : { kind, id, argv: args, epoch: process.env.BASEWARE_EPOCH,
          trace: process.env.BASEWARE_TRACE ? JSON.parse(process.env.BASEWARE_TRACE) : undefined, origin: "cli" };
    } else throw new Error("Missing capability ID; see baseware --help");
  } else if (kind === "help" && id) request = { kind: "help", id, argv: args };
  else throw new Error("Unknown command; see baseware --help");
  const client = await BasewareClient.connect(socket);
  try {
    let value = await client.request(request);
    if (select) value = (value as Record<string, unknown>)[select];
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    if (value && typeof value === "object" && "exitCode" in value) process.exitCode = Number(value.exitCode);
    return value;
  } finally { client.close(); }
}
