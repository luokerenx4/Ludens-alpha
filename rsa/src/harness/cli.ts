import { send, type Request } from "./transport.ts";

export const HELP = `rsa status
rsa auto on [--message <text>]
rsa auto off
rsa consolidate [--seconds <n>]
rsa controller list | <id> --help | <id> <arguments...>

Control management is unavailable inside agent cycles carrying BASEWARE_EPOCH.
The current directory is the workspace; --workspace <path> or RSA_WORKSPACE overrides it.
RSA_SOCKET overrides its default host address. Each workspace resumes its own session.
Use rsa controller for device and workspace capabilities.`;

export const CONTROLLER_HELP = `rsa controller list
rsa controller <id> --help
rsa controller controller/<id> <driver arguments...>
rsa controller python/<path.py>:<function> [--args '<JSON object>']

Device controllers (including sensors) and decorated Python functions share this workspace catalog.
List and help discover capabilities without executing workspace code.
Calls requiring control use BASEWARE_EPOCH from an existing takeover; they never acquire control.
Sensor controllers return observations alongside the execution result and can run without takeover.
Python: from rsa_tools import Client; Client().list(), .help(id), .call(id, arguments).
Driver arguments are string arrays in the API; Python arguments are objects.`;

async function controller(argv: string[], socket: string) {
  const [id, ...args] = argv;
  if (!id || id === "--help") { console.log(CONTROLLER_HELP); return; }
  const request: Request = { kind: "controller", argv: [], epoch: process.env.BASEWARE_EPOCH,
    trace: process.env.BASEWARE_TRACE ? JSON.parse(process.env.BASEWARE_TRACE) : undefined };
  if (id === "list" && args.length === 0) request.action = "list";
  else {
    request.id = id;
    if (args.length === 1 && args[0] === "--help") request.action = "help";
    else {
      request.action = "call";
      if (id.startsWith("python/") && args[0] === "--args") {
        if (args.length !== 2) throw new Error("Usage: rsa controller <id> --args '<JSON>'");
        request.arguments = JSON.parse(args[1]!);
      } else if (args.length || !id.startsWith("python/")) request.arguments = args;
    }
  }
  const value = await send(socket, request);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (request.action === "call" && id.startsWith("controller/") && value && typeof value === "object" && "exitCode" in value) {
    process.exitCode = Number(value.exitCode);
  }
}

export async function cli(argv: string[], socket: string) {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help") { console.log(HELP); return; }
  if (kind === "controller") return controller(rest, socket);
  if (!["status", "auto", "consolidate"].includes(kind)) throw new Error("Unknown command; see rsa --help");
  const control = kind === "auto" || kind === "consolidate" ? await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null } : undefined;
  const value = await send(socket, {
    kind, argv: rest, epoch: process.env.BASEWARE_EPOCH,
    ...(control ? { runId: control.runId, expectedEpoch: control.epoch } : {}),
  });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
