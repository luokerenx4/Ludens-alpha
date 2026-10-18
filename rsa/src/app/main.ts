#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { cli, HELP } from "../harness/cli.ts";
import { Runtime } from "../harness/runtime.ts";
import { listen } from "../harness/transport.ts";
import { createGbaProvider } from "../providers/mgba/provider.ts";
import { createSwitchProvider } from "../providers/ryubing/provider.ts";
import { EventLog } from "../harness/events.ts";
import type { ObservationRequest } from "../contracts.ts";
import { readCurrentSession, resolveWorkspaceState } from "../harness/workspace-state.ts";
import { validateSessionWorkspace } from "../harness/omp/workspace-session.ts";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };

// Runtime state lives beside the monorepo, outside its three component directories.
const artifactRoot = resolve(import.meta.dir, "../../../../artifacts/rsa");
let exit: (code: number) => void | Promise<void> = code => process.exit(code);
const RUN_HELP = `rsa [--workspace <path>] run [--provider mgba|ryubing] [--port <n>] [--workspace <path>] [--device-only] [--model <provider/model>] [--resume <session.jsonl> | --new-session] [--seconds <n>] [--requests <n>] [--compaction-threshold <tokens>] [--auto-observe <JSON>]
Each workspace keeps its own session; --new-session starts fresh without deleting workspace files.
The current directory is the default workspace. Run logs go to <workspace>/logs/<run-id>/.
--resume selects an existing session from the same workspace, then remembers it for future starts.
--compaction-threshold configures OMP's native compaction trigger; default is 256000 tokens.
--auto-observe supplies an array of {sensorId, argv} requests; default is screen capture.
Default provider: mgba. Default bridge ports: mgba=47653, ryubing=47663.`;

async function main() {
  const args = process.argv.slice(2);
  let selectedWorkspace = process.env.RSA_WORKSPACE ?? process.cwd();
  if (args[0] === "--workspace") {
    if (!args[1] || args[1].startsWith("--")) throw new Error("--workspace requires a path");
    selectedWorkspace = args[1];
    args.splice(0, 2);
  }
  if (!args.length || args[0] === "--help" || (args[0] === "run" && args.includes("--help"))) {
    console.log(`${RUN_HELP}\n${HELP}`);
    return;
  }
  if (args[0] !== "run") {
    const socket = process.env.RSA_SOCKET ?? (await resolveWorkspaceState(selectedWorkspace, artifactRoot)).socket;
    return cli(args, socket);
  }
  const { values } = parseArgs({ args: args.slice(1), options: {
    workspace: { type: "string", default: selectedWorkspace },
    provider: { type: "string", default: "mgba" },
    port: { type: "string" },
    "device-only": { type: "boolean", default: false },
    model: { type: "string" },
    resume: { type: "string" },
    "new-session": { type: "boolean", default: false },
    seconds: { type: "string", default: "300" },
    requests: { type: "string", default: "50" },
    "compaction-threshold": { type: "string", default: "256000" },
    "auto-observe": { type: "string" },
  } });
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be positive");
  const maxRequests = Number(values.requests);
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw new Error("--requests must be a positive integer");
  const compactionThreshold = Number(values["compaction-threshold"]);
  if (!Number.isInteger(compactionThreshold) || compactionThreshold <= 0) throw new Error("--compaction-threshold must be a positive integer");
  const autoObserve: ObservationRequest[] = values["auto-observe"] === undefined
    ? [{ sensorId: "screen", argv: ["capture"] }] : JSON.parse(values["auto-observe"]);
  if (!Array.isArray(autoObserve) || autoObserve.some(request => !request || typeof request.sensorId !== "string"
    || !Array.isArray(request.argv) || request.argv.some(arg => typeof arg !== "string"))) throw new Error("--auto-observe expects [{sensorId, argv: string[]}]");
  if (values.resume && values["new-session"]) throw new Error("Use either --resume or --new-session");
  if (values["device-only"] && (values.resume || values["new-session"])) throw new Error("Session options require a model driver");
  if (values.provider !== "mgba" && values.provider !== "ryubing") throw new Error("--provider must be mgba or ryubing");
  const state = await resolveWorkspaceState(values.workspace!, artifactRoot);
  const workspace = state.workspace;
  const socket = process.env.RSA_SOCKET ?? state.socket;
  const runId = new Date().toISOString().replaceAll(":", "-");
  const runDir = join(workspace, "logs", runId);
  const port = Number(values.port ?? (values.provider === "mgba" ? 47653 : 47663));
  const factory = values.provider === "mgba" ? createGbaProvider : createSwitchProvider;
  let provider: Awaited<ReturnType<typeof factory>> | undefined;
  let runtime: Runtime | undefined;
  let log: EventLog | undefined;
  let ready = false;
  const closeServers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    ready = false;
    try { await runtime?.close(); }
    finally {
      provider?.close();
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
    const resume = values["device-only"] || values["new-session"] ? undefined
      : values.resume ? resolve(values.resume) : await readCurrentSession(state);
    if (resume) await validateSessionWorkspace(resume, workspace);
    process.chdir(workspace);
    await mkdir(join(workspace, "skills"), { recursive: true });
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    // Let the dashboard locate logs even when this workspace is outside the checkout.
    await writeFile(join(state.dir, "workspace.json"), JSON.stringify({ workspace }, null, 2));
    const clock = { id: runId, now: () => performance.now() };
    log = new EventLog(runDir, clock);
    log.record("run_start", { workspace, workspaceId: state.id });
    provider = await factory({ port, artifactsDir: join(runDir, "observations"), clock });
    runtime = new Runtime(provider.capabilities, log.record, seconds, runId);
    provider.onDisconnect((error) => { void runtime!.disconnected(error); });
    const model = values.model ?? "openai-codex/gpt-6.1-sol";
    if (!values["device-only"]) {
      // Device-only mode can run without importing OMP or opening credential storage.
      const postmortem = await import("@oh-my-pi/pi-utils/postmortem");
      // OMP's signal handler exits after its registered callbacks, so it must
      // await this host's cleanup too. The signal and finally share one promise.
      unregisterCleanup = postmortem.register("rsa-run", close, { exitOnly: true });
      exit = postmortem.quit;
      const { createOmpDriver } = await import("../harness/omp/session.ts");
      runtime.driver = await createOmpDriver({ runtime, workspace, state, runDir, socket, log, resume,
        binDir: resolve(import.meta.dir, "../../bin"), model, maxRequests, compactionThreshold, autoObserve,
      });
    }
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace, workspaceId: state.id, stateDir: state.dir, socket, provider: values.provider === "mgba" ? "mgba-0.10.5" : "ryubing-1.3.351-rsa.1", port, omp: "18.9.1", eventSchemaVersion: 1, model: values["device-only"] ? null : model, seconds, maxRequests, resume, autoObserve, compactionThreshold: compactionThreshold ?? null }, null, 2));
    ready = true;
    console.log(JSON.stringify({ ready: true, socket, workspace, stateDir: state.dir, runDir, ...runtime.status() }, null, 2));
    await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } finally {
    try { await close(); }
    finally { unregisterCleanup?.(); }
  }
}

// OMP owns process-wide background services; exit after all application cleanup finishes.
main().then(() => exit(Number(process.exitCode ?? 0)), (error) => { console.error(String(error)); return exit(1); });
