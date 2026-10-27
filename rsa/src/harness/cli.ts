import { send, type Request } from "./transport.ts";
import { parseArgs } from "node:util";
import type { ObservationQuery, PerceptionRead } from "./perception.ts";
import { readToolArguments } from "@playness/baseware/tool-contract";
import type { ExecutionResult } from "@playness/baseware/contracts";

export const HELP = `rsa status
rsa auto on [--message <text>]
rsa auto off
rsa consolidate [--seconds <n>]
rsa perception status | reload | stop
rsa observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] [--limit <n>] [--after <sequence>] [--images]
rsa controller list | <id> --help | <id> [--args '<JSON object>' | --file <arguments.json>]

Control management is unavailable inside agent cycles carrying BASEWARE_EPOCH.
The current directory is the workspace; --workspace <path> or RSA_WORKSPACE overrides it.
RSA_SOCKET overrides its default host address. Each workspace resumes its own session.
Use rsa controller for device and workspace capabilities.`;

export const OBSERVE_HELP = `rsa observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] [--limit <n>] [--after <sequence>] [--images]
Read the workspace timeline without sampling. Default: latest Perception.sample record.
--capability selects a perception capability, or '*' for the whole timeline; --id selects a record.
--at selects the last record at or before the given recordedAt timestamp.
--start and --end select an inclusive time range; either bound may be omitted.
Range pages follow recording sequence, default to 8 records (maximum 64), and return hasMore/nextAfter.
--after continues after a record sequence. Query times use recordedAt (sampling completion);
sampledAt, when supplied by the producer, describes the source time separately.
Default output is JSON with media paths. --images also displays the requested pixels through
OMP's native terminal image support; use it when reading pictures through bash.
availability reports the retained range; non-persistent history expires outside its hot window.
The same command is available as rsa perception observe.`;

const PERCEPTION_HELP = `rsa perception status | reload | stop
${OBSERVE_HELP}
Loads workspace/perception.py:Perception in a resident process and calls sample() continuously.
Set sample_hz to choose a target rate (default 2 Hz). Reload after editing code or weights.
Mark sample() with @perception and @record from rsa_tools. Only marked results enter the timeline.
Persistent history survives reload and new runs. Defaults: 10-minute hot window, hourly segments.
Set RSA_PERCEPTION_PERSIST=0 in the host environment for hot-window-only history.
Empty or failed perception supplies no default images.`;

async function observe(argv: string[], socket: string) {
  if (argv.includes("--help")) { console.log(OBSERVE_HELP); return; }
  const { values } = parseArgs({ args: argv, options: {
    capability: { type: "string" }, id: { type: "string" },
    at: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    limit: { type: "string" }, after: { type: "string" }, images: { type: "boolean", default: false },
  } });
  const query: ObservationQuery = {
    ...(values.capability !== undefined ? { capability: values.capability } : {}),
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(values.at !== undefined ? { at: values.at } : {}),
    ...(values.start !== undefined ? { start: values.start } : {}),
    ...(values.end !== undefined ? { end: values.end } : {}),
    ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
    ...(values.after !== undefined ? { after: Number(values.after) } : {}),
  };
  const value = await send(socket, { kind: "perception", argv: ["observe"], query,
    epoch: process.env.BASEWARE_EPOCH,
    trace: process.env.BASEWARE_TRACE ? JSON.parse(process.env.BASEWARE_TRACE) : undefined }) as PerceptionRead;
  process.exitCode = value.result.exitCode;
  const output = values.images
    ? await (await import("./omp/terminal-observation.ts")).terminalObservation(value)
    : JSON.stringify(value, null, 2);
  console.log(output);
}

export const CONTROLLER_HELP = `rsa controller list
rsa controller <id> --help
rsa controller controller/<native name> [--args '<JSON object>' | --file <arguments.json>]
rsa controller python/<path.py>:<function> [--args '<JSON object>' | --file <arguments.json>]

Device controllers (including sensors) and decorated Python functions share this workspace catalog.
List and help discover capabilities without executing workspace code.
Calls requiring control use BASEWARE_EPOCH from an existing takeover; they never acquire control.
Sensor controllers return observations alongside the execution result and can run without takeover.
Python: from rsa_tools import Client; Client().list(), .help(id), .call(id, arguments).
All arguments are objects; --file reads the same complete argument object as --args.`;

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
      request.arguments = await readToolArguments(args);
    }
  }
  const value = await send(socket, request);
  const execution = request.action === "call" && id.startsWith("controller/") ? value as ExecutionResult : undefined;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (execution) process.exitCode = execution.exitCode;
}

export async function cli(argv: string[], socket: string) {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help") { console.log(HELP); return; }
  if (kind === "controller") return controller(rest, socket);
  if (kind === "observe") return observe(rest, socket);
  if (kind === "perception" && rest[0] === "observe") return observe(rest.slice(1), socket);
  if (kind === "perception" && (!rest.length || rest[0] === "--help")) {
    console.log(PERCEPTION_HELP);
    return;
  }
  if (!["status", "auto", "consolidate", "perception"].includes(kind)) throw new Error("Unknown command; see rsa --help");
  const control = kind === "auto" || kind === "consolidate" ? await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null } : undefined;
  const value = await send(socket, {
    kind, argv: rest, epoch: process.env.BASEWARE_EPOCH,
    ...(control ? { runId: control.runId, expectedEpoch: control.epoch } : {}),
  });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
