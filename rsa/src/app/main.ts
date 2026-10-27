#!/usr/bin/env bun
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, join, delimiter } from "node:path";
import { parseArgs } from "node:util";
import { cli, HELP } from "../harness/cli.ts";
import { Runtime } from "../harness/runtime.ts";
import { listen } from "../harness/transport.ts";
import { connectBaseware } from "../harness/baseware.ts";
import { WorkspaceController } from "../harness/controller.ts";
import { defaultSocket } from "@playness/baseware/address";
import { writeCapabilityDocument } from "@playness/baseware/catalog";
import { EventLog, EVENT_SCHEMA_VERSION } from "../harness/events.ts";
import { runProvenance } from "../harness/provenance.ts";
import { PerceptionRuntime } from "../harness/perception.ts";
import { readCurrentSession, resolveWorkspaceState } from "../harness/workspace-state.ts";
import { migrateWorkspaceSessions, validateSessionWorkspace } from "../harness/omp/workspace-session.ts";
import perceptionTemplate from "../../templates/perception.py" with { type: "text" };
import { WORKSPACE_HELP, workspaceCommand } from "./workspace.ts";
import { LOG_HELP, logCommand } from "./log-archive.ts";

// Workspace registry and experience versions live outside the monorepo.
const artifactRoot = resolve(import.meta.dir, "../../../../artifacts/rsa");
let exit: (code: number) => void | Promise<void> = code => process.exit(code);
const RUN_HELP = `rsa [--workspace <path>] run [--baseware-socket <path>] [--workspace <path>] [--device-only] [--model <provider/model>] [--resume <session.jsonl> | --new-session] [--seconds <n>] [--requests <n>] [--compaction-threshold <tokens>]
Each workspace keeps its sessions in .rsa/shiori/; --new-session starts fresh without deleting workspace files.
The current directory is the default workspace. Run logs go to <workspace>/logs/<run-id>/.
--resume selects an existing session from the same workspace, then remembers it for future starts.
--compaction-threshold configures OMP's native compaction trigger; default is 256000 tokens.
Perception starts empty. Implement workspace/perception.py and use rsa perception reload.
Hardware is provided by an independent Baseware service. Its default socket is derived from the workspace.`;

async function main() {
  const args = process.argv.slice(2);
  let selectedWorkspace = process.env.RSA_WORKSPACE ?? process.cwd();
  if (args[0] === "--workspace") {
    if (!args[1] || args[1].startsWith("--")) throw new Error("--workspace requires a path");
    selectedWorkspace = args[1];
    args.splice(0, 2);
  }
  if (!args.length || args[0] === "--help" || (args[0] === "run" && args.includes("--help"))) {
    console.log(`${WORKSPACE_HELP}\n\n${RUN_HELP}\n${HELP}\nrsa bench <list|help|run|history|compare> — unified benchmarks; rsa bench --help\n${LOG_HELP}`);
    return;
  }
  if (args[0] === "bench") return (await import("../benchmark/runner.ts")).benchmarkCommand(args.slice(1), artifactRoot, selectedWorkspace);
  if (args[0] === "logs") return logCommand(args.slice(1));
  if (["init", "up", "services", "down"].includes(args[0]!)) return workspaceCommand(args[0]!, args.slice(1), selectedWorkspace);
  if (args[0] !== "run") {
    const socket = process.env.RSA_SOCKET ?? (await resolveWorkspaceState(selectedWorkspace, artifactRoot)).socket;
    return cli(args, socket);
  }
  const { values } = parseArgs({ args: args.slice(1), options: {
    workspace: { type: "string", default: selectedWorkspace },
    "baseware-socket": { type: "string" },
    "device-only": { type: "boolean", default: false },
    model: { type: "string" },
    resume: { type: "string" },
    "new-session": { type: "boolean", default: false },
    seconds: { type: "string", default: "300" },
    requests: { type: "string", default: "50" },
    "compaction-threshold": { type: "string", default: "256000" },
  } });
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be positive");
  const maxRequests = Number(values.requests);
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw new Error("--requests must be a positive integer");
  const compactionThreshold = Number(values["compaction-threshold"]);
  if (!Number.isInteger(compactionThreshold) || compactionThreshold <= 0) throw new Error("--compaction-threshold must be a positive integer");
  if (values.resume && values["new-session"]) throw new Error("Use either --resume or --new-session");
  if (values["device-only"] && (values.resume || values["new-session"])) throw new Error("Session options require an agent");
  const state = await resolveWorkspaceState(values.workspace!, artifactRoot);
  const workspace = state.workspace;
  const socket = process.env.RSA_SOCKET ?? state.socket;
  const runId = new Date().toISOString().replaceAll(":", "-");
  const runDir = join(workspace, "logs", runId);
  const basewareSocket = values["baseware-socket"] ?? process.env.BASEWARE_SOCKET ?? await defaultSocket(workspace);
  let devices: Awaited<ReturnType<typeof connectBaseware>> | undefined;
  let runtime: Runtime | undefined;
  let log: EventLog | undefined;
  let ready = false;
  const closeServers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    ready = false;
    try { await runtime?.close(); }
    finally {
      devices?.close();
      for (const closeServer of closeServers.reverse()) await closeServer();
      if (runtime) log?.record("run_end", runtime.status());
    }
  })();
  let unregisterCleanup: (() => void) | undefined;
  try {
    // Own the workspace before touching its session or device. A custom address
    // is only an alias, so it cannot start a second writer for this workspace.
    const getRuntime = () => {
      if (!ready || !runtime) throw new Error("Host is starting or closing");
      return runtime;
    };
    closeServers.push(await listen(state.socket, getRuntime));
    if (socket !== state.socket) closeServers.push(await listen(socket, getRuntime));
    if (!values["device-only"]) await migrateWorkspaceSessions(state);
    const resume = values["device-only"] || values["new-session"] ? undefined
      : values.resume ? await realpath(resolve(values.resume)) : await readCurrentSession(state);
    if (resume) await validateSessionWorkspace(resume, workspace);
    process.chdir(workspace);
    await mkdir(join(workspace, "skills"), { recursive: true });
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(workspace, "perception.py"), perceptionTemplate, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    // Let the dashboard locate logs even when this workspace is outside the checkout.
    await writeFile(join(state.dir, "workspace.json"), JSON.stringify({ workspace }, null, 2));
    const clock = { id: runId, now: () => performance.now() };
    log = new EventLog(runDir, clock, workspace);
    log.record("run_start", { workspace, workspaceId: state.id });
    devices = await connectBaseware({ socket: basewareSocket, seconds, runDir, record: log.record });
    await writeCapabilityDocument(devices.catalog, join(workspace, "baseware.json"));
    runtime = new Runtime(devices, log.record, seconds, runId);
    const binDir = resolve(import.meta.dir, "../../bin");
    const environment = {
      RSA_SOCKET: socket, BASEWARE_SOCKET: basewareSocket,
      RSA_WORKSPACE: workspace, RSA_RUN_ID: runId,
      PATH: [binDir, resolve(import.meta.dir, "../../../baseware/bin"), process.env.PATH ?? ""].join(delimiter),
    };
    runtime.controller = new WorkspaceController({ workspace, devices, record: log.record, env: environment });
    runtime.perception = new PerceptionRuntime({ workspace, runDir, env: environment, record: log.record, clock });
    devices.onHandback(reason => { void runtime!.stop(reason); });
    devices.onDisconnect((error) => { void runtime!.disconnected(error); });
    const model = values.model ?? "openai-codex/gpt-6.1-sol";
    if (!values["device-only"]) {
      // Device-only mode can run without importing OMP or opening credential storage.
      const postmortem = await import("@oh-my-pi/pi-utils/postmortem");
      // OMP's signal handler exits after its registered callbacks, so it must
      // await this host's cleanup too. The signal and finally share one promise.
      unregisterCleanup = postmortem.register("rsa-run", close, { exitOnly: true });
      exit = postmortem.quit;
      const { createOmpAgent } = await import("../harness/omp/session.ts");
      runtime.agent = await createOmpAgent({ runtime, workspace, state, runDir, log, resume,
        binDir, rsaSocket: socket, basewareSocket, model, maxRequests, compactionThreshold,
      });
    }
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace, workspaceId: state.id, stateDir: state.dir, socket,
      drivers: devices.catalog.drivers, basewareSocket, omp: "18.9.1", eventSchemaVersion: EVENT_SCHEMA_VERSION,
      shiori: values["device-only"] ? null : { implementation: "omp", implementationVersion: "18.9.1" },
      provenance: await runProvenance(workspace), model: values["device-only"] ? null : model,
      seconds, maxRequests, resume, perception: { entry: "perception.py:Perception" }, compactionThreshold: compactionThreshold ?? null }, null, 2));
    ready = true;
    await runtime.perception.reload();
    console.log(JSON.stringify({ ready: true, socket, workspace, stateDir: state.dir, runDir, ...runtime.status() }, null, 2));
    await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } finally {
    try { await close(); }
    finally { unregisterCleanup?.(); }
  }
}

// OMP owns process-wide background services; exit after all application cleanup finishes.
main().then(() => exit(Number(process.exitCode ?? 0)), (error) => { console.error(String(error)); return exit(1); });
