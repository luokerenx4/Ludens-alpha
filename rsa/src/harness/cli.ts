import { send } from "./transport.ts";

export const HELP = `rsa status
rsa auto on|off
rsa consolidate [--seconds <n>]
rsa sensor list
rsa sensor <id> --help | <arguments...>
rsa controller list
rsa controller <id> --help | <arguments...>

Control commands require RSA_EPOCH from auto on. Agent shells receive it automatically.
The current directory is the workspace; --workspace <path> or RSA_WORKSPACE overrides it.
RSA_SOCKET overrides its default host address. Each workspace resumes its own session.
Capability-specific help comes from its provider.`;

export async function cli(argv: string[], socket: string) {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help") { console.log(HELP); return; }
  const capability = kind === "sensor" || kind === "controller";
  const control = kind === "auto" || kind === "consolidate" ? await send(socket, { kind: "status", argv: [] }) as { runId: string; epoch: string | null } : undefined;
  const value = await send(socket, {
    kind,
    id: capability ? rest[0] : undefined,
    argv: capability ? rest.slice(1) : rest,
    epoch: process.env.RSA_EPOCH,
    ...(control ? { runId: control.runId, expectedEpoch: control.epoch } : {}),
    trace: process.env.RSA_TRACE ? JSON.parse(process.env.RSA_TRACE) : undefined,
  });
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (value && typeof value === "object" && "exitCode" in value) process.exitCode = Number(value.exitCode);
}
