import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchPlan, parseConfig, WorkspaceLauncher, type LaunchIO, type LaunchPlan } from "../src/app/workspace.ts";

class FakeServices implements LaunchIO {
  calls: string[][] = [];
  events: string[] = [];
  jobs = new Map<string, number>();
  starts: string[] = [];
  failStart: string | null = null;
  externalEmulator = false;
  preparedBridgePid: number | null = null;
  bridgeClientPids: number[] = [];
  bridgePort: number;
  dashboard = false;
  mode = "manual";
  cleanupReads = 0;
  clock = 0;

  constructor(readonly plan: LaunchPlan) { this.bridgePort = plan.config.port; }
  target(name: string) {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    return `gui/${process.getuid!()}/dev.playness.rsa.${hash}.${name}`;
  }
  seed(name: string) { this.jobs.set(this.target(name), 100 + this.jobs.size); }
  dashboardReady = async () => this.dashboard;
  sleep = async () => { this.clock += 500; };
  now = () => this.clock;
  note = () => {};
  async run(argv: string[], cwd: string) {
    expect(cwd).toBe(this.plan.workspace);
    this.calls.push([...argv]);
    const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
    if (argv[0] === this.plan.rsa && argv[1] === "status") {
      if (!this.jobs.has(this.target("host"))) return result("", 1);
      const thinking = this.cleanupReads-- > 0;
      this.events.push(`host:${this.mode}:${thinking}`);
      return result(JSON.stringify({ runId: "original-session", mode: this.mode, connected: true,
        thinking, consolidating: false, maxSeconds: this.plan.config.seconds }));
    }
    if (argv[0] === this.plan.rsa && argv.slice(1).join(" ") === "auto off") {
      this.events.push("auto off");
      this.mode = "manual";
      this.cleanupReads = 2;
      return result();
    }
    if (argv[0] === "launchctl" && argv[1] === "print") {
      const pid = this.jobs.get(argv[2]!);
      return pid ? result(`state = running\n pid = ${pid}\n`) : result("", 1);
    }
    if (argv[0] === "launchctl" && argv[1] === "bootout") {
      this.events.push(`stop:${argv[2]}`);
      this.jobs.delete(argv[2]!);
      return result();
    }
    if (argv[0] === "python3" && argv[1] === this.plan.launcher) {
      const name = argv[2]!;
      this.starts.push(name);
      expect(argv.slice(3)).toEqual(this.plan.commands[name as keyof typeof this.plan.commands]!);
      if (name === this.failStart) return result("", 1, `${name} unavailable`);
      this.seed(name);
      if (name === "dashboard") this.dashboard = true;
      return result();
    }
    if (argv[0] === "pgrep") return result(this.externalEmulator ? "999\n" : "", this.externalEmulator ? 0 : 1);
    if (argv[0] === "lsof") {
      const pid = this.jobs.get(this.target("emulator")) ?? this.preparedBridgePid;
      if (argv.includes("-p")) return pid ? result(`p${pid}\nn127.0.0.1:${this.bridgePort}\n`) : result("", 1);
      if (!argv.includes(`-iTCP:${this.bridgePort}`) || !pid) return result("", 1);
      // lsof ESTABLISHED also reports the server PID; it is not a competing host.
      return result(argv.includes("-sTCP:ESTABLISHED") ? [pid, ...this.bridgeClientPids].join("\n") : String(pid));
    }
    if (argv[0] === "kill" && argv[1] === "-0") return result("", [...this.jobs.values()].includes(Number(argv[2])) ? 0 : 1);
    throw new Error(`Unexpected command: ${JSON.stringify(argv)}`);
  }
}

const plan = () => launchPlan(parseConfig({ provider: "ryubing", game: "games/A game; $(touch BAD).nsp" }),
  "/tmp/Workspace with spaces", "/tmp/Source with spaces");

test("launch config keeps limits explicit and paths as literal argv entries", () => {
  const value = plan();
  expect(value.config).toMatchObject({ port: 47663, seconds: 1800, requests: 1000, compactionThreshold: 256000 });
  expect(parseConfig({ provider: "mgba" }).port).toBe(47653);
  expect(() => parseConfig({ provider: "ryubing", second: 10 })).toThrow("Unknown");
  expect(() => parseConfig({ provider: "mgba", game: "game.gba" })).toThrow("mGBA");
  expect(value.commands.emulator).toEqual(["env", "RSA_BRIDGE_PORT=47663",
    "/tmp/Source with spaces/rsa/src/providers/ryubing/launch.sh",
    "/tmp/Workspace with spaces/games/A game; $(touch BAD).nsp"]);
  expect(value.commands.host).toContain("/tmp/Source with spaces/rsa/bin/rsa");
  expect(value.commands.pet).toContain("/tmp/Workspace with spaces");
});

test("init and dry-run preserve existing workspace files and never invoke service commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-launch-"));
  try {
    const workspace = join(directory, "Workspace ; $ literal");
    const bin = join(directory, "bin");
    const marker = join(directory, "service-started");
    await mkdir(workspace);
    await mkdir(bin);
    // Trap any attempt to execute service commands; the CLI itself uses an absolute Bun path.
    for (const name of ["launchctl", "python3", "pgrep", "lsof", "npm", "env"]) {
      const file = join(bin, name);
      await writeFile(file, '#!/bin/sh\nprintf called > "$SERVICE_MARKER"\nexit 97\n');
      await chmod(file, 0o755);
    }
    await writeFile(join(workspace, "AGENTS.md"), "My existing workspace instructions\n");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), ...args], {
        cwd: workspace, env: { ...process.env, PATH: bin, SERVICE_MARKER: marker, RSA_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    expect((await run("init", "--provider", "ryubing", "--game", "games/Uninstalled ; $ game.nsp", "--seconds", "600")).code).toBe(0);
    const configBefore = await readFile(join(workspace, "rsa.json"), "utf8");
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ workspace: await realpath(workspace), config: { seconds: 600 } });
    expect((await run("init", "--provider", "mgba")).code).not.toBe(0);
    expect(await readFile(join(workspace, "rsa.json"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("My existing workspace instructions\n");
    expect((await readdir(workspace)).sort()).toEqual(["AGENTS.md", "rsa.json"]);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed startup preserves ready services and repeated up resumes without duplicate hosts or takeover", async () => {
  const value = plan();
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  io.failStart = "dashboard";
  await expect(launcher.up()).rejects.toThrow("dashboard unavailable");
  expect(io.jobs.has(io.target("host"))).toBe(true);
  expect(io.jobs.has(io.target("emulator"))).toBe(true);
  io.failStart = null;
  const recovered = await launcher.up();
  expect(recovered.host?.mode).toBe("manual");
  await launcher.up();
  expect(io.starts).toEqual(["emulator", "host", "dashboard", "dashboard", "pet"]);
  expect(io.calls.some(argv => argv[1] === "auto")).toBe(false);
  expect(io.calls.some(argv => argv[1] === "bootout")).toBe(false);
});

test("down waits for takeover cleanup, stops only owned jobs, and keeps the shared Dashboard", async () => {
  const value = plan();
  const io = new FakeServices(value);
  for (const name of ["host", "emulator", "pet", "dashboard"]) io.seed(name);
  const foreign = "gui/501/dev.playness.rsa.another-workspace.host";
  io.jobs.set(foreign, 999);
  io.dashboard = true;
  io.mode = "auto";
  await new WorkspaceLauncher(value, io).down(false);
  const stopHost = io.events.indexOf(`stop:${io.target("host")}`);
  expect(io.events.indexOf("auto off")).toBeLessThan(stopHost);
  expect(io.events.indexOf("host:manual:false")).toBeGreaterThan(io.events.indexOf("auto off"));
  expect(io.events.indexOf("host:manual:false")).toBeLessThan(stopHost);
  expect(io.calls.filter(argv => argv[1] === "bootout").map(argv => argv[2])).toEqual(
    ["host", "pet", "emulator"].map(name => io.target(name)));
  expect([...io.jobs.keys()]).toEqual([io.target("dashboard"), foreign]);

  const keep = new FakeServices(value);
  for (const name of ["host", "emulator", "pet", "dashboard"]) keep.seed(name);
  keep.dashboard = true;
  await new WorkspaceLauncher(value, keep).down(false, true);
  expect(keep.calls.filter(argv => argv[1] === "bootout").map(argv => argv[2])).toEqual(
    ["host", "pet"].map(name => keep.target(name)));
  expect([...keep.jobs.keys()]).toEqual([keep.target("emulator"), keep.target("dashboard")]);
});

test("an external Ryubing process blocks startup before spawning or stopping anything", async () => {
  const value = plan();
  const io = new FakeServices(value);
  io.externalEmulator = true;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[1] === "bootout" || argv[1] === "auto")).toBe(false);
});

test("a bridge used by another workspace neither receives a second host nor gets stopped", async () => {
  const prepared = launchPlan(parseConfig({ provider: "ryubing" }), "/tmp/Second workspace");
  const attach = new FakeServices(prepared);
  attach.preparedBridgePid = 700;
  attach.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(prepared, attach).up()).rejects.toThrow("already used by PID 701");
  expect(attach.starts).toEqual([]);

  const value = plan();
  const owner = new FakeServices(value);
  owner.seed("emulator");
  // down must discover the actual port even if rsa.json has since changed.
  owner.bridgePort = 47999;
  owner.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(value, owner).down(false)).rejects.toThrow("bridge client from another host");
  expect(owner.jobs.has(owner.target("emulator"))).toBe(true);
  expect(owner.calls.some(argv => argv[1] === "bootout")).toBe(false);
});
