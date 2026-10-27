import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultSocket } from "@playness/baseware/address";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };
import perceptionTemplate from "../../templates/perception.py" with { type: "text" };

export const WORKSPACE_HELP = `Workspace startup (macOS):
rsa init --driver ryubing|mgba|azahar|cua [--game <path>] [--cua-command <path>] [--seconds <n>]
rsa up [--dry-run]
rsa services
rsa down [--keep-emulator] [--dashboard] [--pet]

These commands use <workspace>/rsa.json. Paths are relative to that workspace.
up starts services in manual mode; use rsa auto on to let the agent act.
Repeated up reuses running services; down then up applies configuration changes.
down stops this workspace's managed host, Baseware and emulator (save your game first).
Use down --keep-emulator before changing host settings to preserve the current game.
The shared Dashboard stays up unless --dashboard is given by its owning workspace.
Alice Pet is shared across workspaces; --pet stops its managed background job.
An Alice app opened separately is reused and stays open after down.
Choose which workspace Alice follows in the Dashboard; up preserves that selection.
Without game, prepare the emulator bridge yourself. mGBA always uses this mode.
cua starts the installed Cua Driver (cua-driver by default); it needs no emulator or bridge port.
azahar provides native gamepad, touch and screen capture through its emulator bridge.`;

export interface LaunchConfig {
  driver: "mgba" | "ryubing" | "azahar" | "cua";
  game?: string;
  port?: number;
  cuaCommand?: string;
  model: string;
  seconds: number;
  requests: number;
  compactionThreshold: number;
  dashboard: boolean;
  pet: boolean;
}

export function parseConfig(value: unknown): LaunchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rsa.json must be an object");
  const config = value as Record<string, unknown>;
  const allowed = ["driver", "game", "port", "cuaCommand", "model", "seconds", "requests", "compactionThreshold", "dashboard", "pet"];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`Unknown rsa.json field: ${key}`);
  if (config.driver !== "mgba" && config.driver !== "ryubing" && config.driver !== "azahar" && config.driver !== "cua") throw new Error("rsa.json driver must be mgba, ryubing, azahar or cua");
  if (config.game !== undefined && (typeof config.game !== "string" || !config.game.trim())) throw new Error("game must be a non-empty path");
  if (config.driver === "mgba" && config.game !== undefined) throw new Error("mGBA: open the ROM and load bridge.lua in Tools → Scripting, then omit game from rsa.json");
  if (config.driver === "cua" && (config.game !== undefined || config.port !== undefined)) throw new Error("cua does not use game or a bridge port");
  if (config.cuaCommand !== undefined && (config.driver !== "cua" || typeof config.cuaCommand !== "string" || !config.cuaCommand.trim())) {
    throw new Error("cuaCommand must be a non-empty executable path for the cua driver");
  }
  const result = { ...(config.driver !== "cua" ? { port: config.driver === "mgba" ? 47653 : config.driver === "azahar" ? 47673 : 47663 } : {}), model: "openai-codex/gpt-6.1-sol",
    seconds: 1800, requests: 1000, compactionThreshold: 256000, dashboard: true, pet: true, ...config } as LaunchConfig;
  for (const key of ["seconds", "requests", "compactionThreshold"] as const) {
    if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (result.port !== undefined && (!Number.isInteger(result.port) || result.port <= 0 || result.port > 65535)) throw new Error("port must be an integer from 1 to 65535");
  if (typeof result.model !== "string" || !result.model.trim()) throw new Error("model must be a non-empty string");
  for (const key of ["dashboard", "pet"] as const) if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean`);
  return result;
}

type ServiceName = "emulator" | "baseware" | "host" | "dashboard" | "pet";
export interface LaunchPlan {
  workspace: string;
  config: LaunchConfig;
  dashboardUrl: string;
  dashboardCheck: string[];
  background: string;
  sharedPet: { cwd: string; background: string };
  launcher: string;
  rsa: string;
  baseware: string;
  basewareSocket: string;
  commands: Partial<Record<ServiceName, string[]>>;
}

export async function launchPlan(config: LaunchConfig, workspace: string, repo = resolve(import.meta.dir, "../../.."), socket?: string): Promise<LaunchPlan> {
  const rsa = join(repo, "rsa/bin/rsa");
  const baseware = join(repo, "baseware/bin/baseware");
  const basewareSocket = socket ?? await defaultSocket(workspace);
  const background = join(workspace, "logs/background");
  const sharedPet = { cwd: repo, background: resolve(repo, "../artifacts/rsa/alice/background") };
  return {
    workspace, config, dashboardUrl: "http://127.0.0.1:3015", background, sharedPet,
    dashboardCheck: ["npm", "--prefix", join(repo, "rsa-dashboard"), "run", "check-build"],
    launcher: join(repo, "rsa/scripts/launch-background.py"), rsa, baseware, basewareSocket,
    commands: {
      ...(config.game ? { emulator: ["env", `RSA_BRIDGE_PORT=${config.port}`,
        join(repo, `baseware/src/drivers/${config.driver}/launch.sh`), resolve(workspace, config.game)] } : {}),
      baseware: [baseware, "serve", "--driver", config.driver,
        ...(config.driver !== "cua" ? ["--port", String(config.port)] : []),
        ...(config.cuaCommand ? ["--cua-command", config.cuaCommand] : []), "--socket", basewareSocket,
        "--data-dir", join(workspace, "logs/baseware")],
      host: [rsa, "run", "--baseware-socket", basewareSocket, "--model", config.model,
        "--seconds", String(config.seconds), "--requests", String(config.requests), "--compaction-threshold", String(config.compactionThreshold),
      ],
      ...(config.dashboard ? { dashboard: ["npm", "--prefix", join(repo, "rsa-dashboard"), "run", "start"] } : {}),
      ...(config.pet ? { pet: [join(repo, "rsa-companion/bin/rsa-companion"), "--workspace", workspace, "--show-window"] } : {}),
    },
  };
}

type CommandResult = { code: number; stdout: string; stderr: string };
type HostStatus = { runId: string; mode: string; connected: boolean; thinking: boolean; consolidating: boolean; maxSeconds: number };
type BasewareStatus = { serviceId: string; mode: string; connected: boolean; epoch: string | null };
type Job = { target: string; registered: boolean; pid: number | null; state: string | null; lastExitCode: number | null };
export interface LaunchIO {
  run(argv: string[], cwd: string): Promise<CommandResult>;
  dashboardReady(url: string): Promise<boolean>;
  aliceReady(url: string): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  note(message: string): void;
}

const systemIO: LaunchIO = {
  async run(argv, cwd) {
    const env = { ...process.env };
    // Workspace selection must not inherit a previous agent shell's address or lease.
    for (const key of Object.keys(env)) {
      if (key.startsWith("BASEWARE_") || ["RSA_SOCKET", "RSA_WORKSPACE"].includes(key)) delete env[key];
    }
    const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  },
  async dashboardReady(url) {
    try {
      const response = await fetch(`${url}/api/catalog`, { signal: AbortSignal.timeout(2000) });
      return response.ok && Array.isArray(await response.json());
    } catch { return false; }
  },
  async aliceReady(url) {
    try {
      const response = await fetch(`${url}/api/alice`, { signal: AbortSignal.timeout(10_000) });
      return response.ok && (await response.json()).connected === true;
    } catch { return false; }
  },
  sleep: () => Bun.sleep(500), now: Date.now, note: message => console.error(message),
};

// Thin orchestration over the existing CLI and launchd script. No supervisor or restart loop.
export class WorkspaceLauncher {
  constructor(readonly plan: LaunchPlan, private io: LaunchIO = systemIO) {}

  private run(argv: string[], cwd = this.plan.workspace) { return this.io.run(argv, cwd); }
  private async checked(argv: string[], cwd = this.plan.workspace) {
    const result = await this.run(argv, cwd);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${argv[0]} exited ${result.code}`);
    return result;
  }
  async job(name: ServiceName): Promise<Job> {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    const label = name === "pet" ? "dev.playness.alice.pet" : `dev.playness.rsa.${hash}.${name}`;
    const target = `gui/${process.getuid!()}/${label}`;
    const result = await this.run(["launchctl", "print", target]);
    return { target, registered: result.code === 0,
      pid: Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
      state: result.stdout.match(/^\s*state = (.+)$/m)?.[1] ?? null,
      lastExitCode: result.stdout.match(/^\s*last exit code = (-?\d+)$/m) ? Number(result.stdout.match(/^\s*last exit code = (-?\d+)$/m)![1]) : null };
  }
  async host(): Promise<HostStatus | null> {
    const result = await this.run([this.plan.rsa, "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async baseware(): Promise<BasewareStatus | null> {
    const result = await this.run(["env", `BASEWARE_SOCKET=${this.plan.basewareSocket}`, this.plan.baseware, "status"]);
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  }
  async status() {
    const [host, baseware, dashboard, alice, ...jobs] = await Promise.all([this.host(), this.baseware(), this.io.dashboardReady(this.plan.dashboardUrl), this.io.aliceReady(this.plan.dashboardUrl),
      ...(["emulator", "baseware", "host", "dashboard", "pet"] as const).map(async name => ({
        name, scope: name === "pet" ? "shared" : "workspace", ...await this.job(name), log: this.log(name),
      }))]);
    return { workspace: this.plan.workspace, host, baseware, dashboard: { url: this.plan.dashboardUrl, ready: dashboard }, pet: { connected: alice }, jobs };
  }
  private log(name: ServiceName) {
    return join(name === "pet" ? this.plan.sharedPet.background : this.plan.background, `${name}.log`);
  }
  private async waitFor<T>(description: string, probe: () => Promise<T | null | false>): Promise<T> {
    const deadline = this.io.now() + 120_000;
    do {
      const result = await probe();
      if (result) return result;
      await this.io.sleep();
    } while (this.io.now() < deadline);
    throw new Error(`Timed out waiting for ${description}. Check ${this.plan.background}; use rsa services to inspect remaining processes.`);
  }
  private async ensure(name: ServiceName) {
    const job = await this.job(name);
    if (job.pid) { this.io.note(`Reusing ${name} (PID ${job.pid}).`); return; }
    // launchd retains completed jobs. Remove only this managed service's stopped registration.
    if (job.registered) await this.checked(["launchctl", "bootout", job.target]);
    this.io.note(`Starting ${name}; log: ${this.log(name)}`);
    await this.checked(["python3", this.plan.launcher,
      ...(name === "pet" ? ["--label", "dev.playness.alice.pet", "--log-dir", this.plan.sharedPet.background] : []),
      name, ...this.plan.commands[name]!], name === "pet" ? this.plan.sharedPet.cwd : this.plan.workspace);
  }
  private async alive(name: ServiceName) {
    const job = await this.job(name);
    if (!job.registered || (!job.pid && job.lastExitCode !== null)) throw new Error(`${name} exited; see ${this.log(name)}`);
    return job.pid;
  }
  private async listeningPids(port: number) {
    const result = await this.run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  }
  private async bridgeClients(port: number) {
    const listeners = await this.listeningPids(port);
    const result = await this.run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-t"]);
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => !listeners.includes(pid));
  }
  async up() {
    // Fail before launching the device when the permanent Dashboard would run stale code.
    let dashboard = await this.io.dashboardReady(this.plan.dashboardUrl);
    if (this.plan.config.dashboard && !dashboard) {
      const build = await this.run(this.plan.dashboardCheck);
      if (build.code !== 0) throw new Error(build.stderr || build.stdout || "Build the Dashboard before starting it.");
    }
    let baseware = await this.baseware();
    if (!baseware) {
      const existing = await this.job("baseware");
      if (!existing.pid) {
        if (this.plan.config.driver !== "cua") {
          const port = this.plan.config.port!;
          if (this.plan.commands.emulator) {
            const emulator = await this.job("emulator");
            if (!emulator.pid) {
              const executable = this.plan.config.driver === "azahar" ? "/Applications/Azahar.app/Contents/MacOS/azahar" : "/Applications/Ryubing.app/Contents/MacOS/Ryujinx";
              const running = await this.run(["pgrep", "-f", `^${executable}`]);
              if (running.code === 0) throw new Error(`${this.plan.config.driver} is already running outside this workspace's emulator job. Use its workspace, or omit game to explicitly connect to the prepared device.`);
            }
            await this.ensure("emulator");
            await this.waitFor("this emulator's bridge listener", async () => {
              const pid = await this.alive("emulator");
              return !!pid && (await this.listeningPids(port)).includes(pid);
            });
          } else if (!(await this.listeningPids(port)).length) {
            throw new Error(`No prepared bridge on port ${port}. ${this.plan.config.driver === "mgba"
              ? "Open the ROM in mGBA and load baseware/src/drivers/mgba/bridge.lua in Tools → Scripting."
              : `Start the patched ${this.plan.config.driver} with the desired game, or set game in rsa.json.`}`);
          }
          // Only probe bridge ownership when there is no reusable Baseware service.
          const clients = await this.bridgeClients(port);
          if (clients.length) throw new Error(`Bridge port ${port} is already used by PID ${clients.join(", ")}. Use its Baseware service or stop it before switching workspaces.`);
        }
        await this.ensure("baseware");
      }
      baseware = await this.waitFor("Baseware service", async () => {
        const value = await this.baseware();
        if (value) return value;
        await this.alive("baseware");
        return false;
      });
    } else this.io.note(`Reusing Baseware ${baseware.serviceId}; running settings are unchanged.`);
    if (!baseware.connected) throw new Error("Baseware is alive but its device is disconnected. Inspect rsa services before stopping and starting it again.");

    let host = await this.host();
    if (!host) {
      await this.ensure("host");
      host = await this.waitFor("RSA host", async () => {
        const value = await this.host();
        if (value) return value;
        await this.alive("host");
        return false;
      });
    } else this.io.note(`Reusing host ${host.runId}; running settings are unchanged.`);
    if (!host.connected) throw new Error("Host is alive but its device is disconnected. Inspect rsa services before stopping and starting it again.");

    dashboard = await this.io.dashboardReady(this.plan.dashboardUrl);
    if (this.plan.config.dashboard && !dashboard) {
      if (!(await this.job("dashboard")).pid && (await this.listeningPids(3015)).length) throw new Error("Port 3015 is occupied but the RSA Dashboard API is not ready; inspect that service before retrying.");
      await this.ensure("dashboard");
      dashboard = await this.waitFor("Dashboard API", async () => {
        if (await this.io.dashboardReady(this.plan.dashboardUrl)) return true;
        await this.alive("dashboard");
        return false;
      });
    }
    if (this.plan.config.pet) {
      if (!dashboard) throw new Error("Pet needs the Dashboard. Enable dashboard in rsa.json or start it separately.");
      if (await this.io.aliceReady(this.plan.dashboardUrl)) this.io.note("Reusing Alice's connected desktop instance.");
      else {
        await this.ensure("pet");
        await this.waitFor(`Alice activity connection (${this.log("pet")})`, async () => {
          if (await this.io.aliceReady(this.plan.dashboardUrl)) return true;
          const job = await this.job("pet");
          // Electron's single-instance lock can exit successfully while an existing app connects.
          if (!job.registered || (!job.pid && job.lastExitCode !== null && job.lastExitCode !== 0))
            throw new Error(`pet exited; see ${this.log("pet")}`);
          return false;
        });
      }
    }
    this.io.note(host.mode === "auto" ? "Existing takeover is still running." : "Ready in manual mode. Run rsa auto on to start acting.");
    return this.status();
  }
  async down(includeDashboard: boolean, keepEmulator = false, includePet = false) {
    const managedHost = await this.job("host");
    if (managedHost.pid) {
      const host = await this.host();
      if (host?.mode === "auto") await this.checked([this.plan.rsa, "auto", "off"]);
      if (host) await this.waitFor("model cleanup", async () => {
        const status = await this.host();
        return !status || (!status.thinking && !status.consolidating);
      });
    }
    for (const name of ["host", "baseware", ...(!keepEmulator ? ["emulator"] : []), ...(includePet ? ["pet"] : []), ...(includeDashboard ? ["dashboard"] : [])] as ServiceName[]) {
      const job = await this.job(name);
      if (!job.registered) continue;
      // A manually launched host or another lease holder may still own the device.
      if ((name === "baseware" || name === "emulator") && await this.host()) throw new Error(`An unmanaged host still owns this workspace. Stop it before shutting down ${name}.`);
      if (name === "baseware") {
        const service = await this.baseware();
        if (service && service.mode !== "manual") throw new Error("Baseware still has an active owner. Release its control lease before shutting it down.");
      }
      if (name === "emulator" && job.pid) {
        // An external-device workspace may have attached to this emulator since our host stopped.
        const listeners = await this.run(["lsof", "-a", "-p", String(job.pid), "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"]);
        for (const match of listeners.stdout.matchAll(/^n.*:(\d+)$/gm)) {
          if ((await this.bridgeClients(Number(match[1]))).length) throw new Error("Emulator still has a bridge client from another Baseware service; stop that service before closing it.");
        }
      }
      await this.checked(["launchctl", "bootout", job.target]);
      if (job.pid) await this.waitFor(`${name} to exit`, async () => (await this.run(["kill", "-0", String(job.pid)])).code !== 0);
      this.io.note(`Stopped ${name}.`);
    }
    return this.status();
  }
}

export async function workspaceCommand(command: string, args: string[], selectedWorkspace: string) {
  if (args.includes("--help")) { console.log(WORKSPACE_HELP); return; }
  const { values } = parseArgs({ args, options: command === "init" ? {
    driver: { type: "string" }, game: { type: "string" }, "cua-command": { type: "string" }, seconds: { type: "string" },
  } : command === "up" ? { "dry-run": { type: "boolean" } }
    : command === "down" ? { dashboard: { type: "boolean" }, pet: { type: "boolean" }, "keep-emulator": { type: "boolean" } } : {} });
  if (command === "init") {
    const config = parseConfig({ driver: values.driver,
      ...(values.game ? { game: values.game } : {}), ...(values["cua-command"] ? { cuaCommand: values["cua-command"] } : {}),
      ...(values.seconds ? { seconds: Number(values.seconds) } : {}) });
    await mkdir(selectedWorkspace, { recursive: true });
    const workspace = await realpath(selectedWorkspace);
    await writeFile(join(workspace, "rsa.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await writeFile(join(workspace, "perception.py"), perceptionTemplate, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    console.log(`Created ${join(workspace, "rsa.json")}\nReview with rsa up --dry-run, then run rsa up.`);
    return;
  }
  const workspace = await realpath(selectedWorkspace);
  // Status and shutdown remain available even if the launch config was removed or edited badly.
  const config = command === "up" ? parseConfig(await Bun.file(join(workspace, "rsa.json")).json()) : parseConfig({ driver: "mgba" });
  const plan = await launchPlan(config, workspace);
  if (values["dry-run"]) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.platform !== "darwin") throw new Error("Workspace service commands currently use macOS launchd");
  if (command === "up") {
    const repo = resolve(import.meta.dir, "../../..");
    const required = [
      ...(config.game ? [resolve(workspace, config.game), config.driver === "azahar" ? "/Applications/Azahar.app/Contents/MacOS/azahar" : "/Applications/Ryubing.app/Contents/MacOS/Ryujinx"] : []),
      ...(config.dashboard ? [join(repo, "rsa-dashboard/node_modules/next/package.json")] : []),
      ...(config.pet ? [join(repo, "rsa-companion/dist/electron/main.js"), join(repo, "rsa-companion/node_modules/electron/package.json")] : []),
    ];
    for (const path of required) if (!await Bun.file(path).exists()) throw new Error(`Missing ${path}. Install/build the components as described in README.md.`);
  }
  const launcher = new WorkspaceLauncher(plan);
  const result = command === "up" ? await launcher.up() : command === "down"
    ? await launcher.down(Boolean(values.dashboard), Boolean(values["keep-emulator"]), Boolean(values.pet)) : await launcher.status();
  console.log(JSON.stringify(result, null, 2));
}
