import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import workspaceGuide from "../../templates/AGENTS.md" with { type: "text" };

export const WORKSPACE_HELP = `Workspace startup (macOS):
rsa init --provider ryubing|mgba [--game <path>] [--seconds <n>]
rsa up [--dry-run]
rsa services
rsa down [--keep-emulator] [--dashboard]

These commands use <workspace>/rsa.json. Paths are relative to that workspace.
up starts services in manual mode; use rsa auto on to let the agent play.
Repeated up reuses running services; down then up applies configuration changes.
down stops this workspace's managed host, Pet and emulator (save your game first).
Use down --keep-emulator before changing host settings to preserve the current game.
The shared Dashboard stays up unless --dashboard is given by its owning workspace.
Without game, prepare the emulator bridge yourself. mGBA always uses this mode.`;

export interface LaunchConfig {
  provider: "mgba" | "ryubing";
  game?: string;
  port: number;
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
  const allowed = ["provider", "game", "port", "model", "seconds", "requests", "compactionThreshold", "dashboard", "pet"];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`Unknown rsa.json field: ${key}`);
  if (config.provider !== "mgba" && config.provider !== "ryubing") throw new Error("rsa.json provider must be mgba or ryubing");
  if (config.game !== undefined && (typeof config.game !== "string" || !config.game.trim())) throw new Error("game must be a non-empty path");
  if (config.provider === "mgba" && config.game !== undefined) throw new Error("mGBA: open the ROM and load bridge.lua in Tools → Scripting, then omit game from rsa.json");
  const result = { port: config.provider === "mgba" ? 47653 : 47663, model: "openai-codex/gpt-6.1-sol",
    seconds: 1800, requests: 1000, compactionThreshold: 256000, dashboard: true, pet: true, ...config } as LaunchConfig;
  for (const key of ["port", "seconds", "requests", "compactionThreshold"] as const) {
    if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (result.port > 65535) throw new Error("port must be at most 65535");
  if (typeof result.model !== "string" || !result.model.trim()) throw new Error("model must be a non-empty string");
  for (const key of ["dashboard", "pet"] as const) if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean`);
  return result;
}

type ServiceName = "emulator" | "host" | "dashboard" | "pet";
export interface LaunchPlan {
  workspace: string;
  config: LaunchConfig;
  dashboardUrl: string;
  background: string;
  launcher: string;
  rsa: string;
  commands: Partial<Record<ServiceName, string[]>>;
}

export function launchPlan(config: LaunchConfig, workspace: string, repo = resolve(import.meta.dir, "../../..")): LaunchPlan {
  const rsa = join(repo, "rsa/bin/rsa");
  const background = join(workspace, "logs/background");
  return {
    workspace, config, dashboardUrl: "http://127.0.0.1:3015", background,
    launcher: join(repo, "rsa/scripts/launch-background.py"), rsa,
    commands: {
      ...(config.game ? { emulator: ["env", `RSA_BRIDGE_PORT=${config.port}`,
        join(repo, "rsa/src/providers/ryubing/launch.sh"), resolve(workspace, config.game)] } : {}),
      host: [rsa, "run", "--provider", config.provider, "--port", String(config.port), "--model", config.model,
        "--seconds", String(config.seconds), "--requests", String(config.requests), "--compaction-threshold", String(config.compactionThreshold)],
      ...(config.dashboard ? { dashboard: ["npm", "--prefix", join(repo, "rsa-dashboard"), "run", "dev"] } : {}),
      ...(config.pet ? { pet: [join(repo, "rsa-companion/bin/rsa-companion"), "--workspace", workspace,
        "--profile", join(background, "pet-profile"), "--show-window"] } : {}),
    },
  };
}

type CommandResult = { code: number; stdout: string; stderr: string };
type HostStatus = { runId: string; mode: string; connected: boolean; thinking: boolean; consolidating: boolean; maxSeconds: number };
type Job = { target: string; registered: boolean; pid: number | null; state: string | null; lastExitCode: number | null };
export interface LaunchIO {
  run(argv: string[], cwd: string): Promise<CommandResult>;
  dashboardReady(url: string): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  note(message: string): void;
}

const systemIO: LaunchIO = {
  async run(argv, cwd) {
    const env = { ...process.env };
    // Workspace selection must not inherit a previous agent shell's address or lease.
    for (const key of ["RSA_SOCKET", "RSA_WORKSPACE", "RSA_EPOCH", "RSA_TRACE"]) delete env[key];
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
  sleep: () => Bun.sleep(500), now: Date.now, note: message => console.error(message),
};

// Thin orchestration over the existing CLI and launchd script. No supervisor or restart loop.
export class WorkspaceLauncher {
  constructor(readonly plan: LaunchPlan, private io: LaunchIO = systemIO) {}

  private run(argv: string[]) { return this.io.run(argv, this.plan.workspace); }
  private async checked(argv: string[]) {
    const result = await this.run(argv);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${argv[0]} exited ${result.code}`);
    return result;
  }
  async job(name: ServiceName): Promise<Job> {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    const target = `gui/${process.getuid!()}/dev.playness.rsa.${hash}.${name}`;
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
  async status() {
    const [host, dashboard, ...jobs] = await Promise.all([this.host(), this.io.dashboardReady(this.plan.dashboardUrl),
      ...(["emulator", "host", "dashboard", "pet"] as const).map(async name => ({ name, ...await this.job(name), log: join(this.plan.background, `${name}.log`) }))]);
    return { workspace: this.plan.workspace, host, dashboard: { url: this.plan.dashboardUrl, ready: dashboard }, jobs };
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
    // launchd retains completed jobs. Remove only this workspace's stopped registration.
    if (job.registered) await this.checked(["launchctl", "bootout", job.target]);
    this.io.note(`Starting ${name}; log: ${join(this.plan.background, `${name}.log`)}`);
    await this.checked(["python3", this.plan.launcher, name, ...this.plan.commands[name]!]);
  }
  private async alive(name: ServiceName) {
    const job = await this.job(name);
    if (!job.registered || (!job.pid && job.lastExitCode !== null)) throw new Error(`${name} exited; see ${join(this.plan.background, `${name}.log`)}`);
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
    let host = await this.host();
    if (!host) {
      const existing = await this.job("host");
      if (!existing.pid) {
        if (this.plan.commands.emulator) {
          const emulator = await this.job("emulator");
          if (!emulator.pid) {
            const running = await this.run(["pgrep", "-f", "^/Applications/Ryubing.app/Contents/MacOS/Ryujinx"]);
            if (running.code === 0) throw new Error("Ryubing is already running outside this workspace's emulator job. Use its workspace, or omit game to explicitly connect to the prepared device.");
          }
          await this.ensure("emulator");
          await this.waitFor("this emulator's bridge listener", async () => {
            const pid = await this.alive("emulator");
            return !!pid && (await this.listeningPids(this.plan.config.port)).includes(pid);
          });
        } else if (!(await this.listeningPids(this.plan.config.port)).length) {
          throw new Error(`No prepared bridge on port ${this.plan.config.port}. ${this.plan.config.provider === "mgba"
            ? "Open the ROM in mGBA and load rsa/src/providers/mgba/bridge.lua in Tools → Scripting."
            : "Start the patched Ryubing with the desired game, or set game in rsa.json."}`);
        }
        // Bridges accept one host. A second TCP client could otherwise wait indefinitely for HELLO.
        const clients = await this.bridgeClients(this.plan.config.port);
        if (clients.length) throw new Error(`Bridge port ${this.plan.config.port} is already used by PID ${clients.join(", ")}. Stop its host before switching workspaces.`);
        await this.ensure("host");
      }
      host = await this.waitFor("RSA host", async () => {
        const value = await this.host();
        if (value) return value;
        await this.alive("host");
        return false;
      });
    } else this.io.note(`Reusing host ${host.runId}; running settings are unchanged.`);
    if (!host.connected) throw new Error("Host is alive but its device is disconnected. Inspect rsa services before stopping and starting it again.");

    let dashboard = await this.io.dashboardReady(this.plan.dashboardUrl);
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
      await this.ensure("pet");
      // Surface immediate Electron failures (missing build / profile already in use).
      await this.io.sleep();
      await this.waitFor("Pet process", () => this.alive("pet"));
    }
    this.io.note(host.mode === "auto" ? "Existing takeover is still running." : "Ready in manual mode. Run rsa auto on to start playing.");
    return this.status();
  }
  async down(includeDashboard: boolean, keepEmulator = false) {
    const managedHost = await this.job("host");
    if (managedHost.pid) {
      const host = await this.host();
      if (host?.mode === "auto") await this.checked([this.plan.rsa, "auto", "off"]);
      if (host) await this.waitFor("model cleanup", async () => {
        const status = await this.host();
        return !status || (!status.thinking && !status.consolidating);
      });
    }
    for (const name of ["host", "pet", ...(!keepEmulator ? ["emulator"] : []), ...(includeDashboard ? ["dashboard"] : [])] as ServiceName[]) {
      const job = await this.job(name);
      if (!job.registered) continue;
      // A manually launched host may still own the emulator. Never stop its device here.
      if (name === "emulator" && await this.host()) throw new Error("An unmanaged host still owns this workspace. Stop it before shutting down the emulator.");
      if (name === "emulator" && job.pid) {
        // An external-device workspace may have attached to this emulator since our host stopped.
        const listeners = await this.run(["lsof", "-a", "-p", String(job.pid), "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"]);
        for (const match of listeners.stdout.matchAll(/^n.*:(\d+)$/gm)) {
          if ((await this.bridgeClients(Number(match[1]))).length) throw new Error("Emulator still has a bridge client from another host; stop that host before closing it.");
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
    provider: { type: "string" }, game: { type: "string" }, seconds: { type: "string" },
  } : command === "up" ? { "dry-run": { type: "boolean" } }
    : command === "down" ? { dashboard: { type: "boolean" }, "keep-emulator": { type: "boolean" } } : {} });
  if (command === "init") {
    const config = parseConfig({ provider: values.provider,
      ...(values.game ? { game: values.game } : {}), ...(values.seconds ? { seconds: Number(values.seconds) } : {}) });
    await mkdir(selectedWorkspace, { recursive: true });
    const workspace = await realpath(selectedWorkspace);
    await writeFile(join(workspace, "rsa.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(workspace, "AGENTS.md"), workspaceGuide, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    console.log(`Created ${join(workspace, "rsa.json")}\nReview with rsa up --dry-run, then run rsa up.`);
    return;
  }
  const workspace = await realpath(selectedWorkspace);
  // Status and shutdown remain available even if the launch config was removed or edited badly.
  const config = command === "up" ? parseConfig(await Bun.file(join(workspace, "rsa.json")).json()) : parseConfig({ provider: "mgba" });
  const plan = launchPlan(config, workspace);
  if (values["dry-run"]) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.platform !== "darwin") throw new Error("Workspace service commands currently use macOS launchd");
  if (command === "up") {
    const repo = resolve(import.meta.dir, "../../..");
    const required = [
      ...(config.game ? [resolve(workspace, config.game), "/Applications/Ryubing.app/Contents/MacOS/Ryujinx"] : []),
      ...(config.dashboard ? [join(repo, "rsa-dashboard/node_modules/next/package.json")] : []),
      ...(config.pet ? [join(repo, "rsa-companion/dist/electron/main.js"), join(repo, "rsa-companion/node_modules/electron/package.json")] : []),
    ];
    for (const path of required) if (!await Bun.file(path).exists()) throw new Error(`Missing ${path}. Install/build the components as described in README.md.`);
  }
  const launcher = new WorkspaceLauncher(plan);
  const result = command === "up" ? await launcher.up() : command === "down"
    ? await launcher.down(Boolean(values.dashboard), Boolean(values["keep-emulator"])) : await launcher.status();
  console.log(JSON.stringify(result, null, 2));
}
