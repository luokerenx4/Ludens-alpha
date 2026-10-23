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
  externalBaseware = false;
  externalHost = false;
  externalAlice = false;
  aliceReadyAfter = 0;
  basewareConnected = true;
  basewareMode = "manual";
  preparedBridgePid: number | null = null;
  bridgeClientPids: number[] = [];
  bridgePort: number | undefined;
  dashboard = false;
  mode = "manual";
  cleanupReads = 0;
  clock = 0;

  constructor(readonly plan: LaunchPlan) { this.bridgePort = plan.config.port; }
  target(name: string) {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    return `gui/${process.getuid!()}/${name === "pet" ? "dev.playness.alice.pet" : `dev.playness.rsa.${hash}.${name}`}`;
  }
  seed(name: string) { this.jobs.set(this.target(name), 100 + this.jobs.size); }
  dashboardReady = async () => this.dashboard;
  aliceReady = async () => this.externalAlice || (this.jobs.has(this.target("pet")) && this.clock >= this.aliceReadyAfter);
  sleep = async () => { this.clock += 500; };
  now = () => this.clock;
  note = () => {};
  async run(argv: string[], cwd: string) {
    const sharedPetLaunch = argv[0] === "python3" && argv[2] === "--label";
    expect(cwd).toBe(sharedPetLaunch ? this.plan.sharedPet.cwd : this.plan.workspace);
    this.calls.push([...argv]);
    const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
    if (argv[0] === "env" && argv[2] === this.plan.baseware && argv[3] === "status") {
      expect(argv[1]).toBe(`BASEWARE_SOCKET=${this.plan.basewareSocket}`);
      if (!this.jobs.has(this.target("baseware")) && !this.externalBaseware) return result("", 1);
      this.events.push(`baseware:${this.basewareMode}:${this.basewareConnected}`);
      return result(JSON.stringify({ serviceId: "device-session", mode: this.basewareMode,
        connected: this.basewareConnected, epoch: this.basewareMode === "auto" ? "another-owner" : null }));
    }
    if (argv[0] === this.plan.rsa && argv[1] === "status") {
      if (!this.jobs.has(this.target("host")) && !this.externalHost) return result("", 1);
      const thinking = this.cleanupReads-- > 0;
      this.events.push(`host:${this.mode}:${thinking}`);
      return result(JSON.stringify({ runId: "original-session", mode: this.mode, connected: true,
        thinking, consolidating: false, maxSeconds: this.plan.config.seconds }));
    }
    if (argv[0] === this.plan.rsa && argv.slice(1).join(" ") === "auto off") {
      this.events.push("auto off");
      this.mode = "manual";
      this.basewareMode = "manual";
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
      const nameIndex = sharedPetLaunch ? 6 : 2;
      const name = argv[nameIndex]!;
      this.starts.push(name);
      if (sharedPetLaunch) expect(argv.slice(2, 6)).toEqual(["--label", "dev.playness.alice.pet", "--log-dir", this.plan.sharedPet.background]);
      expect(argv.slice(nameIndex + 1)).toEqual(this.plan.commands[name as keyof typeof this.plan.commands]!);
      if (name === this.failStart) return result("", 1, `${name} unavailable`);
      if (name === "host") expect(this.events).toContain("baseware:manual:true");
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
      const baseware = this.jobs.get(this.target("baseware"));
      return result(argv.includes("-sTCP:ESTABLISHED") ? [pid, ...(baseware ? [baseware] : []), ...this.bridgeClientPids].join("\n") : String(pid));
    }
    if (argv[0] === "kill" && argv[1] === "-0") return result("", [...this.jobs.values()].includes(Number(argv[2])) ? 0 : 1);
    throw new Error(`Unexpected command: ${JSON.stringify(argv)}`);
  }
}

const plan = () => launchPlan(parseConfig({ driver: "ryubing", game: "games/A game; $(touch BAD).nsp" }),
  "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock");

test("launch config keeps limits explicit and paths as literal argv entries", async () => {
  const value = await plan();
  expect(value.config).toMatchObject({ port: 47663, seconds: 1800, requests: 1000, compactionThreshold: 256000 });
  expect(parseConfig({ driver: "mgba" }).port).toBe(47653);
  expect(() => parseConfig({ driver: "ryubing", second: 10 })).toThrow("Unknown");
  expect(() => parseConfig({ driver: "mgba", game: "game.gba" })).toThrow("mGBA");
  expect(value.commands.emulator).toEqual(["env", "RSA_BRIDGE_PORT=47663",
    "/tmp/Source with spaces/baseware/src/drivers/ryubing/launch.sh",
    "/tmp/Workspace with spaces/games/A game; $(touch BAD).nsp"]);
  expect(value.commands.baseware).toEqual(["/tmp/Source with spaces/baseware/bin/baseware", "serve",
    "--driver", "ryubing", "--port", "47663", "--socket", "/tmp/baseware-test.sock",
    "--data-dir", "/tmp/Workspace with spaces/logs/baseware"]);
  expect(value.commands.host).toContain("/tmp/Source with spaces/rsa/bin/rsa");
  expect(value.commands.host).toContain("--baseware-socket");
  expect(value.commands.host).not.toContain("--driver");
  expect(value.commands.host).not.toContain("--port");
  expect(value.commands.pet).toContain("/tmp/Workspace with spaces");
  expect(value.commands.pet).not.toContain("--profile");
  expect(value.sharedPet).toEqual({ cwd: "/tmp/Source with spaces", background: "/tmp/artifacts/rsa/alice/background" });
});

test("Cua launch config uses its native service without choosing a workspace observation", async () => {
  const config = parseConfig({ driver: "cua", cuaCommand: "/Applications/Cua Driver/cua-driver", dashboard: false, pet: false });
  const value = await launchPlan(config, "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock");
  expect(config.port).toBeUndefined();
  expect(value.commands.emulator).toBeUndefined();
  expect(value.commands.baseware).toEqual(["/tmp/Source/baseware/bin/baseware", "serve", "--driver", "cua",
    "--cua-command", "/Applications/Cua Driver/cua-driver", "--socket", "/tmp/cua-baseware.sock",
    "--data-dir", "/tmp/Desktop workspace/logs/baseware"]);
  expect(value.commands.host).not.toContain("--auto-observe");
  const defaults = await launchPlan(parseConfig({ driver: "cua" }), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock");
  expect(defaults.commands.baseware).not.toContain("--cua-command");
  expect(defaults.commands.baseware).not.toContain("--port");
  expect(() => parseConfig({ driver: "cua", port: 47663 })).toThrow("bridge port");
  expect(() => parseConfig({ driver: "cua", game: "game.nsp" })).toThrow("game");
  expect(() => parseConfig({ driver: "mgba", cuaCommand: "cua-driver" })).toThrow("cuaCommand");
});

test("Cua startup and shutdown only manage its services, without emulator bridge probes", async () => {
  const value = await launchPlan(parseConfig({ driver: "cua", dashboard: false, pet: false }), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock");
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.host?.mode).toBe("manual");
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.down(false);
  expect(io.calls.filter(argv => argv[1] === "bootout").map(argv => argv[2])).toEqual(
    ["host", "baseware"].map(name => io.target(name)));
  expect(io.calls.some(argv => ["pgrep", "lsof"].includes(argv[0]!))).toBe(false);
});

test("Azahar launches its own native device without desktop dependencies", async () => {
  const config = parseConfig({ driver: "azahar", game: "games/3DS game.cci" });
  const value = await launchPlan(config, "/tmp/3DS workspace", "/tmp/Source", "/tmp/3ds-baseware.sock");
  expect(config.port).toBe(47673);
  expect(value.commands.emulator).toEqual(["env", "RSA_BRIDGE_PORT=47673",
    "/tmp/Source/baseware/src/drivers/azahar/launch.sh", "/tmp/3DS workspace/games/3DS game.cci"]);
  expect(value.commands.baseware).toContain("azahar");
  expect(value.commands.baseware).toContain("47673");
  expect(value.commands.baseware).not.toContain("--cua-command");
  expect(value.commands.host).not.toContain("--auto-observe");
  expect(() => parseConfig({ driver: "azahar", cuaCommand: "/tools/cua-driver" })).toThrow("cua driver");
  const io = new FakeServices(value);
  io.bridgePort = 47673;
  expect((await new WorkspaceLauncher(value, io).up()).host?.mode).toBe("manual");
  expect(io.starts).toContain("emulator");
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
    expect((await run("init", "--driver", "ryubing", "--game", "games/Uninstalled ; $ game.nsp", "--seconds", "600")).code).toBe(0);
    const configBefore = await readFile(join(workspace, "rsa.json"), "utf8");
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ workspace: await realpath(workspace), config: { seconds: 600 } });
    expect((await run("init", "--driver", "mgba")).code).not.toBe(0);
    expect(await readFile(join(workspace, "rsa.json"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("My existing workspace instructions\n");
    expect((await readdir(workspace)).sort()).toEqual(["AGENTS.md", "perception.py", "rsa.json"]);
    expect(await readFile(join(workspace, "perception.py"), "utf8")).toContain("NotImplementedError");
    const desktop = join(directory, "Desktop workspace");
    expect((await run("--workspace", desktop, "init", "--driver", "cua", "--cua-command", "./tools/cua-driver")).code).toBe(0);
    const desktopPreview = await run("--workspace", desktop, "up", "--dry-run");
    expect(desktopPreview.code).toBe(0);
    expect(JSON.parse(desktopPreview.stdout)).toMatchObject({ config: { driver: "cua", cuaCommand: "./tools/cua-driver" } });
    expect(JSON.parse(desktopPreview.stdout).commands.emulator).toBeUndefined();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed startup preserves ready services and repeated up resumes without duplicate hosts or takeover", async () => {
  const value = await plan();
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
  expect(io.starts).toEqual(["emulator", "baseware", "host", "dashboard", "dashboard", "pet"]);
  expect(recovered.baseware).toMatchObject({ connected: true, serviceId: "device-session" });
  expect(io.calls.some(argv => argv[1] === "auto")).toBe(false);
  expect(io.calls.some(argv => argv[1] === "bootout")).toBe(false);
});

test("down waits for takeover cleanup, stops only owned jobs, and keeps the shared Dashboard and Pet", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet", "dashboard"]) io.seed(name);
  const foreign = "gui/501/dev.playness.rsa.another-workspace.host";
  io.jobs.set(foreign, 999);
  io.dashboard = true;
  io.mode = "auto";
  io.basewareMode = "auto";
  await new WorkspaceLauncher(value, io).down(false);
  const stopHost = io.events.indexOf(`stop:${io.target("host")}`);
  expect(io.events.indexOf("auto off")).toBeLessThan(stopHost);
  expect(io.events.indexOf("host:manual:false")).toBeGreaterThan(io.events.indexOf("auto off"));
  expect(io.events.indexOf("host:manual:false")).toBeLessThan(stopHost);
  expect(io.calls.filter(argv => argv[1] === "bootout").map(argv => argv[2])).toEqual(
    ["host", "baseware", "emulator"].map(name => io.target(name)));
  expect([...io.jobs.keys()]).toEqual([io.target("pet"), io.target("dashboard"), foreign]);

  const keep = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet", "dashboard"]) keep.seed(name);
  keep.dashboard = true;
  await new WorkspaceLauncher(value, keep).down(false, true);
  expect(keep.calls.filter(argv => argv[1] === "bootout").map(argv => argv[2])).toEqual(
    ["host", "baseware"].map(name => keep.target(name)));
  expect([...keep.jobs.keys()]).toEqual([keep.target("emulator"), keep.target("pet"), keep.target("dashboard")]);
});

test("two workspaces reuse one Alice process and either workspace can explicitly stop it", async () => {
  const first = await launchPlan(parseConfig({ driver: "cua" }), "/tmp/First workspace", "/tmp/Source", "/tmp/first-baseware.sock");
  const second = await launchPlan(parseConfig({ driver: "cua" }), "/tmp/Second workspace", "/tmp/Source", "/tmp/second-baseware.sock");
  const firstIO = new FakeServices(first);
  const firstStatus = await new WorkspaceLauncher(first, firstIO).up();
  const firstPet = firstStatus.jobs.find(job => job.name === "pet")!;
  expect(firstPet).toMatchObject({ scope: "shared", log: "/tmp/artifacts/rsa/alice/background/pet.log" });

  const secondIO = new FakeServices(second);
  secondIO.jobs = firstIO.jobs;
  secondIO.dashboard = true;
  const secondLauncher = new WorkspaceLauncher(second, secondIO);
  const secondStatus = await secondLauncher.up();
  expect(secondIO.starts).toEqual(["baseware", "host"]);
  expect(secondStatus.jobs.find(job => job.name === "pet")).toEqual(firstPet);
  expect(secondIO.calls.some(argv => argv.includes("--workspace"))).toBe(false);

  await secondLauncher.down(false);
  expect(secondIO.jobs.get(secondIO.target("pet"))).toBe(firstPet.pid!);
  await secondLauncher.down(false, true, true);
  expect(secondIO.jobs.has(secondIO.target("pet"))).toBe(false);
  expect(secondIO.jobs.has(firstIO.target("host"))).toBe(true);
});

test("up reuses an independently opened Alice and down never closes that app", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalAlice = true;
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.pet.connected).toBe(true);
  expect(status.jobs.find(job => job.name === "pet")).toMatchObject({ registered: false, pid: null });
  expect(io.starts).not.toContain("pet");
  await launcher.down(false, true, true);
  expect(io.calls.some(argv => argv[1] === "bootout" && argv[2] === io.target("pet"))).toBe(false);
  expect((await launcher.status()).pet.connected).toBe(true);
});

test("managed Alice startup waits for its activity connection after the process appears", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.aliceReadyAfter = 1500;
  const status = await new WorkspaceLauncher(value, io).up();
  expect(io.clock).toBe(1500);
  expect(status.pet.connected).toBe(true);
  expect(io.starts.filter(name => name === "pet")).toEqual(["pet"]);
});

test("shared launchd options write the chosen label and logs while preserving a stable working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-shared-launch-"));
  try {
    const bin = join(directory, "bin");
    const stableCwd = join(directory, "source");
    const logs = join(directory, "shared", "alice", "background");
    await mkdir(bin);
    await mkdir(stableCwd);
    const launchctl = join(bin, "launchctl");
    await writeFile(launchctl, '#!/bin/sh\nif [ "$1" = print ]; then exit 1; fi\nexit 0\n');
    await chmod(launchctl, 0o755);
    const script = resolve(import.meta.dir, "../scripts/launch-background.py");
    const child = Bun.spawn(["/usr/bin/python3", script, "--label", "dev.playness.alice.pet", "--log-dir", logs, "pet", "/bin/echo", "--workspace", "/tmp/seed workspace"], {
      cwd: stableCwd, env: { ...process.env, PATH: bin, RSA_WORKSPACE: "/tmp/stale",
        RSA_PERCEPTION_PERSIST: "0", RSA_PERCEPTION_HOT_SECONDS: "600" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const canonicalCwd = await realpath(stableCwd);
    const canonicalLogs = await realpath(logs);
    expect(JSON.parse(stdout)).toMatchObject({
      target: `gui/${process.getuid!()}/dev.playness.alice.pet`, workspace: canonicalCwd,
      log: join(canonicalLogs, "pet.log"), plist: join(canonicalLogs, "pet.plist"),
    });
    const plist = await readFile(join(logs, "pet.plist"), "utf8");
    expect(plist).toContain("<string>dev.playness.alice.pet</string>");
    expect(plist).toContain(`<key>WorkingDirectory</key>\n\t<string>${canonicalCwd}</string>`);
    expect(plist).toContain(`<string>${join(canonicalLogs, "pet.log")}</string>`);
    expect(plist).not.toContain("RSA_WORKSPACE");
    expect(plist).toContain("<key>RSA_PERCEPTION_PERSIST</key>\n\t\t<string>0</string>");
    expect(plist).toContain("<key>RSA_PERCEPTION_HOT_SECONDS</key>\n\t\t<string>600</string>");
    expect(await readdir(stableCwd)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an external Ryubing process blocks startup before spawning or stopping anything", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalEmulator = true;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[1] === "bootout" || argv[1] === "auto")).toBe(false);
});

test("a bridge used by another workspace neither receives a second host nor gets stopped", async () => {
  const prepared = await launchPlan(parseConfig({ driver: "ryubing" }), "/tmp/Second workspace", undefined, "/tmp/second-baseware.sock");
  const attach = new FakeServices(prepared);
  attach.preparedBridgePid = 700;
  attach.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(prepared, attach).up()).rejects.toThrow("already used by PID 701");
  expect(attach.starts).toEqual([]);

  const value = await plan();
  const owner = new FakeServices(value);
  owner.seed("emulator");
  // down must discover the actual port even if rsa.json has since changed.
  owner.bridgePort = 47999;
  owner.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(value, owner).down(false)).rejects.toThrow("bridge client from another Baseware service");
  expect(owner.jobs.has(owner.target("emulator"))).toBe(true);
  expect(owner.calls.some(argv => argv[1] === "bootout")).toBe(false);
});

test("a connected Baseware service is reused without probing its occupied emulator bridge", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalBaseware = true;
  io.externalEmulator = true;
  io.bridgeClientPids = [701];
  const status = await new WorkspaceLauncher(value, io).up();
  expect(status.baseware?.connected).toBe(true);
  expect(io.starts).toEqual(["host", "dashboard", "pet"]);
  expect(io.calls.some(argv => argv[0] === "pgrep" || (argv[0] === "lsof" && argv.includes(`-iTCP:${value.config.port}`)))).toBe(false);
});

test("a failed or disconnected Baseware service never starts the RSA host", async () => {
  const value = await plan();
  const failed = new FakeServices(value);
  failed.failStart = "baseware";
  await expect(new WorkspaceLauncher(value, failed).up()).rejects.toThrow("baseware unavailable");
  expect(failed.starts).toEqual(["emulator", "baseware"]);
  expect(failed.jobs.has(failed.target("emulator"))).toBe(true);

  const disconnected = new FakeServices(value);
  disconnected.seed("baseware");
  disconnected.basewareConnected = false;
  await expect(new WorkspaceLauncher(value, disconnected).up()).rejects.toThrow("Baseware is alive but its device is disconnected");
  expect(disconnected.starts).toEqual([]);
});

test("down preserves Baseware and its emulator while an unmanaged host or lease still owns them", async () => {
  const value = await plan();
  for (const owner of ["host", "lease"] as const) {
    const io = new FakeServices(value);
    io.seed("baseware");
    io.seed("emulator");
    io.externalHost = owner === "host";
    io.basewareMode = owner === "lease" ? "auto" : "manual";
    await expect(new WorkspaceLauncher(value, io).down(false)).rejects.toThrow(owner === "host" ? "unmanaged host" : "active owner");
    expect(io.calls.some(argv => argv[1] === "bootout")).toBe(false);
  }
});
