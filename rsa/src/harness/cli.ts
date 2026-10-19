import { send } from "./transport.ts";

export const HELP = `rsa status
rsa auto on [--message <text>]
rsa auto off
rsa consolidate [--seconds <n>]

Control management is unavailable inside agent cycles carrying BASEWARE_EPOCH.
The current directory is the workspace; --workspace <path> or RSA_WORKSPACE overrides it.
RSA_SOCKET overrides its default host address. Each workspace resumes its own session.
Use baseware for device discovery and actions.`;

export async function cli(argv: string[], socket: string) {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help") { console.log(HELP); return; }
  if (!["status", "auto", "consolidate"].includes(kind)) throw new Error("Unknown command; see rsa --help");
  const control = kind === "auto" || kind === "consolidate" ? await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null } : undefined;
  const value = await send(socket, {
    kind, argv: rest, epoch: process.env.BASEWARE_EPOCH,
    ...(control ? { runId: control.runId, expectedEpoch: control.epoch } : {}),
  });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
