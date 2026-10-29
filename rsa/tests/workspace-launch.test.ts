import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchPlan, parseConfig, WorkspaceLauncher, type DriverManifest, type LaunchIO, type LaunchPlan } from "../src/app/workspace.ts";
import { getDriver } from "@ludens/baseware/drivers/registry.ts";

const fixtureManifests: Record<string, DriverManifest> = {
  "bridge-fixture": { id: "bridge-fixture", transport: "bridge", defaultPort: 47991, needsGame: true,
    launchCommand: ["/fixture/Emulator.app/Contents/MacOS/emulator"], launchEnv: { FIXTURE_STACK_SIZE: "200000" } },
  "prepared-fixture": { id: "prepared-fixture", transport: "bridge", defaultPort: 47990 },
  "dual-fixture": { id: "dual-fixture", transport: "bridge", defaultPort: 47992, needsGame: true,
    launchCommand: ["/fixture/Dual.app/Contents/MacOS/dual"] },
};
const manifestFor = (id: string): DriverManifest => {
  if (fixtureManifests[id]) return fixtureManifests[id];
  const { load: _load, fallbackVersion: _fallback, ...manifest } = getDriver(id);
  return { ...manifest, version: _fallback };
};

class FakeServices implements LaunchIO {
  calls: string[][] = [];
  events: string[] = [];
  jobs = new Map<string, number>();
  starts: string[] = [];
  failStart: string | null = null;
  externalEmulator = false;
  externalBaseware = false;
  externalHost = false;
  externalPet = false;
  petReadyAfter = 0;
  basewareConnected = true;
  basewareMode = "manual";
  preparedBridgePid: number | null = null;
  bridgeClientPids: number[] = [];
  bridgePort: number | undefined;
  dashboard = false;
  dashboardBuild = true;
  mode = "manual";
  cleanupReads = 0;
  clock = 0;

  constructor(readonly plan: LaunchPlan) { this.bridgePort = plan.config.port; }
  target(name: string) {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    return `gui/${process.getuid!()}/${name === "pet" ? "dev.ludens.pet" : `dev.ludens.rsa.${hash}.${name}`}`;
  }
  seed(name: string) { this.jobs.set(this.target(name), 100 + this.jobs.size); }
  dashboardReady = async () => this.dashboard;
  petReady = async () => this.externalPet || (this.jobs.has(this.target("pet")) && this.clock >= this.petReadyAfter);
  sleep = async () => { this.clock += 500; };
  now = () => this.clock;
  note = () => {};
  async run(argv: string[], cwd: string) {
    const sharedPetLaunch = argv[0] === "python3" && argv[2] === "--label";
    expect(cwd).toBe(sharedPetLaunch ? this.plan.sharedPet.cwd : this.plan.workspace);
    this.calls.push([...argv]);
    const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
    if (argv.join("\0") === this.plan.dashboardCheck.join("\0")) return this.dashboardBuild ? result() : result("", 1, "Dashboard production build is stale; run build");
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
      if (sharedPetLaunch) expect(argv.slice(2, 6)).toEqual(["--label", "dev.ludens.pet", "--log-dir", this.plan.sharedPet.background]);
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

const plan = () => launchPlan(parseConfig({ driver: "bridge-fixture", game: "games/A game; $(touch BAD).nsp", pet: true }, manifestFor("bridge-fixture")),
  "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock", manifestFor("bridge-fixture"));

test("default web startup starts the Dashboard without launching or waiting for Electron", async () => {
  const config = parseConfig({ driver: "cua" }, manifestFor("cua"));
  expect(config).toMatchObject({ dashboard: true, pet: false });
  const value = await launchPlan(config, "/tmp/Web workspace", "/tmp/Source", "/tmp/web-baseware.sock", manifestFor("cua"));
  expect(value.commands.pet).toBeUndefined();
  const io = new FakeServices(value);
  io.petReadyAfter = Infinity;
  const launcher = new WorkspaceLauncher(value, io);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host", "dashboard"]);
  expect(io.clock).toBe(0);
  // Disabling startup must also leave a Pet opened by another workspace alone.
  io.seed("pet");
  await launcher.up();
  expect(io.jobs.has(io.target("pet"))).toBe(true);
  expect(io.calls.some(argv => argv[1] === "bootout")).toBe(false);
});

test("system Pet readiness uses the Dashboard pet endpoint", async () => {
  const paths: string[] = [];
  let connected = true, status = 200;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path === "/api/pet" ? Response.json({ connected }, { status }) : new Response("missing", { status: 404 });
  } });
  // Exercise the real HTTP probe without running launchctl or any device command.
  const io = new WorkspaceLauncher(await plan())["io"];
  try {
    expect(await io.petReady(server.url.origin)).toBe(true);
    connected = false;
    expect(await io.petReady(server.url.origin)).toBe(false);
    connected = true; status = 503;
    expect(await io.petReady(server.url.origin)).toBe(false);
    expect(paths).toEqual(["/api/pet", "/api/pet", "/api/pet"]);
  } finally { server.stop(true); }
});

test("managed Dashboard uses a current production build and fails before starting devices when stale", async () => {
  const value = await plan();
  expect(value.commands.dashboard).toEqual(["npm", "--prefix", "/tmp/Source with spaces/rsa-dashboard", "run", "start"]);
  const io = new FakeServices(value);
  io.dashboardBuild = false;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("production build is stale");
  expect(io.starts).toEqual([]);
  expect(io.calls).toEqual([value.dashboardCheck]);
});

test("launch config keeps limits explicit and paths as literal argv entries", async () => {
  const value = await plan();
  expect(value.config).toMatchObject({ port: 47991, seconds: 1800, requests: 1000 });
  // Default follows the selected model's native OMP compaction trigger; no flag is passed.
  expect(parseConfig({ driver: "prepared-fixture" }, manifestFor("prepared-fixture")).compactionThreshold).toBeUndefined();
  expect(value.commands.host).not.toContain("--compaction-threshold");
  const explicit = await launchPlan(parseConfig({ driver: "bridge-fixture", game: "games/x.nsp", compactionThreshold: 200000 }, manifestFor("bridge-fixture")),
    "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock", manifestFor("bridge-fixture"));
  expect(explicit.commands.host).toEqual(expect.arrayContaining(["--compaction-threshold", "200000"]));
  expect(parseConfig({ driver: "prepared-fixture" }, manifestFor("prepared-fixture")).port).toBe(47990);
  expect(() => parseConfig({ driver: "bridge-fixture", second: 10 }, manifestFor("bridge-fixture"))).toThrow("Unknown");
  expect(() => parseConfig({ driver: "prepared-fixture", game: "game.gba" }, manifestFor("prepared-fixture"))).toThrow("does not support launching a game");
  expect(value.commands.emulator).toEqual(["env", "FIXTURE_STACK_SIZE=200000", "RSA_BRIDGE_PORT=47991",
    ...manifestFor("bridge-fixture").launchCommand!,
    "/tmp/Workspace with spaces/games/A game; $(touch BAD).nsp"]);
  expect(value.commands.baseware).toEqual(["/tmp/Source with spaces/baseware/bin/baseware", "serve",
    "--driver", "bridge-fixture", "--port", "47991", "--socket", "/tmp/baseware-test.sock",
    "--data-dir", "/tmp/Workspace with spaces/logs/baseware", "--diagnostics", "normal"]);
  expect(value.commands.host).toContain("/tmp/Source with spaces/rsa/bin/rsa");
  expect(value.commands.host).toContain("--baseware-socket");
  expect(value.commands.host).not.toContain("--driver");
  expect(value.commands.host).not.toContain("--port");
  expect(value.commands.pet).toContain("/tmp/Workspace with spaces");
  expect(value.commands.pet).not.toContain("--profile");
  expect(value.sharedPet).toEqual({ cwd: "/tmp/Source with spaces", background: "/tmp/artifacts/rsa/alice/background" });
});

test("bridge plugins require a resolved port before any services start", () => {
  const manifest: DriverManifest = { id: "fixture", transport: "bridge" };
  expect(() => parseConfig({ driver: "fixture" }, manifest)).toThrow("requires a bridge port");
  expect(parseConfig({ driver: "fixture", port: 47991 }, manifest).port).toBe(47991);
  expect(parseConfig({ driver: "fixture" }, { ...manifest, defaultPort: 47992 }).port).toBe(47992);
  expect(() => parseConfig({ driver: "fixture" }, { ...manifest, defaultPort: 65536 })).toThrow("1 to 65535");
});

test("an explicit bridge port overrides plugin launch environment for both backend and Baseware", async () => {
  const manifest: DriverManifest = { id: "fixture", transport: "bridge", defaultPort: 47991,
    launchCommand: ["fixture-emulator"], launchEnv: { RSA_BRIDGE_PORT: "47992", FIXTURE_OPTION: "kept" } };
  const config = parseConfig({ driver: "fixture", port: 47993, game: "game.rom" }, manifest);
  const value = await launchPlan(config, "/tmp/fixture", "/tmp/Source", "/tmp/fixture.sock", manifest);
  const command = value.commands.emulator!;
  // Exercise env's effective value, rather than relying on an argv order assertion.
  const child = Bun.spawn([...command.slice(0, -2), process.execPath, "-e",
    "process.stdout.write(JSON.stringify([process.env.RSA_BRIDGE_PORT, process.env.FIXTURE_OPTION]))"],
    { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const [backendPort, option] = JSON.parse(await new Response(child.stdout).text());
  expect(backendPort).toBe("47993");
  expect(option).toBe("kept");
  expect(value.commands.baseware![value.commands.baseware!.indexOf("--port") + 1]).toBe(backendPort);
});

test("Cua launch config uses its native service without choosing a workspace observation", async () => {
  const config = parseConfig({ driver: "cua", cuaCommand: "/Applications/Cua Driver/cua-driver", dashboard: false, pet: false }, manifestFor("cua"));
  const value = await launchPlan(config, "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(config.port).toBeUndefined();
  expect(value.commands.emulator).toBeUndefined();
  expect(value.commands.baseware).toEqual(["/tmp/Source/baseware/bin/baseware", "serve", "--driver", "cua",
    "--cua-command", "/Applications/Cua Driver/cua-driver", "--socket", "/tmp/cua-baseware.sock",
    "--data-dir", "/tmp/Desktop workspace/logs/baseware", "--diagnostics", "normal"]);
  expect(value.commands.host).not.toContain("--auto-observe");
  const defaults = await launchPlan(parseConfig({ driver: "cua" }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(defaults.commands.baseware).not.toContain("--cua-command");
  expect(defaults.commands.baseware).not.toContain("--port");
  expect(() => parseConfig({ driver: "cua", port: 47991 }, manifestFor("cua"))).toThrow("bridge port");
  expect(() => parseConfig({ driver: "cua", game: "game.nsp" }, manifestFor("cua"))).toThrow("game");
  expect(() => parseConfig({ driver: "prepared-fixture", cuaCommand: "cua-driver" }, manifestFor("prepared-fixture"))).toThrow("cuaCommand");
});

test("Cua startup and shutdown only manage its services, without emulator bridge probes", async () => {
  const value = await launchPlan(parseConfig({ driver: "cua", dashboard: false, pet: false }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
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

test("an external bridge manifest launches its device without desktop dependencies", async () => {
  const config = parseConfig({ driver: "dual-fixture", game: "games/3DS game.cci" }, manifestFor("dual-fixture"));
  const value = await launchPlan(config, "/tmp/3DS workspace", "/tmp/Source", "/tmp/3ds-baseware.sock", manifestFor("dual-fixture"));
  expect(config.port).toBe(47992);
  expect(value.commands.emulator).toEqual(["env", "RSA_BRIDGE_PORT=47992",
    "/fixture/Dual.app/Contents/MacOS/dual", "/tmp/3DS workspace/games/3DS game.cci"]);
  expect(value.commands.baseware).toContain("dual-fixture");
  expect(value.commands.baseware).toContain("47992");
  expect(value.commands.baseware).not.toContain("--cua-command");
  expect(value.commands.host).not.toContain("--auto-observe");
  expect(() => parseConfig({ driver: "dual-fixture", game: "games/3DS game.cci", cuaCommand: "/tools/cua-driver" }, manifestFor("dual-fixture"))).toThrow("stdio driver");
  const io = new FakeServices(value);
  io.bridgePort = 47992;
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
    const packagePath = join(directory, "external-driver.ts");
    await writeFile(packagePath, `export default { ...${JSON.stringify(fixtureManifests["bridge-fixture"])}, load() { throw new Error("init must not load the provider"); } };`);
    expect((await run("init", "--driver", "bridge-fixture", "--driver-package", `file:${packagePath}`, "--game", "games/Uninstalled ; $ game.nsp", "--seconds", "600")).code).toBe(0);
    const configBefore = await readFile(join(workspace, "rsa.json"), "utf8");
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ workspace: await realpath(workspace), config: { seconds: 600, pet: false } });
    expect(JSON.parse(preview.stdout).commands.pet).toBeUndefined();
    const withPet = await run("up", "--pet", "--dry-run");
    expect(withPet.code).toBe(0);
    expect(JSON.parse(withPet.stdout).commands.pet).toBeDefined();
    expect((await run("up", "--pet", "--no-pet", "--dry-run")).stderr).toContain("Choose either --pet or --no-pet");
    const repeated = await run("init", "--driver", "cua");
    expect(repeated.code).not.toBe(0);
    expect(repeated.stderr).toContain("EEXIST");
    expect(await readFile(join(workspace, "rsa.json"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("My existing workspace instructions\n");
    expect((await readdir(workspace)).sort()).toEqual(["AGENTS.md", "action.py", "perception.py", "rsa.json"]);
    expect(await readFile(join(workspace, "perception.py"), "utf8")).toContain("NotImplementedError");
    expect(await readFile(join(workspace, "action.py"), "utf8")).toContain("NotImplementedError");
    const desktop = join(directory, "Desktop workspace");
    expect((await run("--workspace", desktop, "init", "--driver", "cua", "--cua-command", "./tools/cua-driver", "--pet")).code).toBe(0);
    const desktopPreview = await run("--workspace", desktop, "up", "--dry-run");
    expect(desktopPreview.code).toBe(0);
    expect(JSON.parse(desktopPreview.stdout)).toMatchObject({ config: { driver: "cua", cuaCommand: "./tools/cua-driver", pet: true } });
    expect(JSON.parse(desktopPreview.stdout).commands.emulator).toBeUndefined();
    expect(JSON.parse(desktopPreview.stdout).commands.pet).toBeDefined();
    const webOnly = await run("--workspace", desktop, "up", "--no-pet", "--dry-run");
    expect(webOnly.code).toBe(0);
    expect(JSON.parse(webOnly.stdout).commands.pet).toBeUndefined();
    expect(JSON.parse(await readFile(join(desktop, "rsa.json"), "utf8")).pet).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("external packages resolve workspace-relative file specs and check only executable argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-package-launch-"));
  try {
    const workspace = join(directory, "workspace");
    const driver = join(workspace, "driver");
    const bin = join(directory, "bin");
    await mkdir(driver, { recursive: true });
    await mkdir(bin);
    await writeFile(join(driver, "package.json"), JSON.stringify({
      name: "workspace-launch-fixture", version: "1.0.0", type: "module", exports: "./index.ts",
    }));
    await writeFile(join(driver, "index.ts"), 'export default { id: "fixture", transport: "bridge", defaultPort: 47991, launchCommand: ["fixture-emulator", "--headless", "literal argument"], load: async () => { throw new Error("Provider must not load during discovery"); } };');
    await writeFile(join(workspace, "game.rom"), "");
    for (const name of ["fixture-emulator", "launchctl", "python3", "lsof", "env", "pgrep"]) {
      const path = join(bin, name);
      await writeFile(path, '#!/bin/sh\necho launch-stopped >&2\nexit 97\n');
      await chmod(path, 0o755);
    }
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), "--workspace", workspace, ...args], {
        cwd: directory, env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const initialized = await run("init", "--driver", "fixture", "--driver-package", "file:./driver", "--game", "game.rom");
    expect(initialized.code).toBe(0);
    const config = JSON.parse(await readFile(join(workspace, "rsa.json"), "utf8"));
    expect(config.driverPackage).toBe(`file:${await realpath(driver)}`);
    // Hand-edited relative specs must receive the same workspace interpretation on up.
    await writeFile(join(workspace, "rsa.json"), JSON.stringify({ ...config, driverPackage: "file:./driver", dashboard: false, pet: false }));
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    const plan = JSON.parse(preview.stdout);
    expect(plan.commands.baseware).toContain(`file:${await realpath(driver)}`);
    expect(plan.commands.emulator).toEqual(["env", "RSA_BRIDGE_PORT=47991", "fixture-emulator", "--headless", "literal argument", join(await realpath(workspace), "game.rom")]);
    if (process.platform === "darwin") {
      const startup = await run("up");
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toContain("launch-stopped");
      expect(startup.stderr).not.toContain("Missing");
      await chmod(join(bin, "fixture-emulator"), 0o644);
      const unavailable = await run("up");
      expect(unavailable.stderr).toContain("Missing executable fixture-emulator");
    }
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
  const foreign = "gui/501/dev.ludens.rsa.another-workspace.host";
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

test("two workspaces reuse one Ludens Pet process and either workspace can explicitly stop it", async () => {
  const first = await launchPlan(parseConfig({ driver: "cua", pet: true }, manifestFor("cua")), "/tmp/First workspace", "/tmp/Source", "/tmp/first-baseware.sock", manifestFor("cua"));
  const second = await launchPlan(parseConfig({ driver: "cua", pet: true }, manifestFor("cua")), "/tmp/Second workspace", "/tmp/Source", "/tmp/second-baseware.sock", manifestFor("cua"));
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

test("up reuses an independently opened Ludens Pet and down never closes that app", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalPet = true;
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.pet.connected).toBe(true);
  expect(status.jobs.find(job => job.name === "pet")).toMatchObject({ registered: false, pid: null });
  expect(io.starts).not.toContain("pet");
  await launcher.down(false, true, true);
  expect(io.calls.some(argv => argv[1] === "bootout" && argv[2] === io.target("pet"))).toBe(false);
  expect((await launcher.status()).pet.connected).toBe(true);
});

test("managed Ludens Pet startup waits for its activity connection after the process appears", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.petReadyAfter = 1500;
  const status = await new WorkspaceLauncher(value, io).up();
  expect(io.clock).toBe(1500);
  expect(status.pet.connected).toBe(true);
  expect(io.starts.filter(name => name === "pet")).toEqual(["pet"]);
});

test("shared launchd options preserve the working directory, Python override and driver cache environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-shared-launch-"));
  try {
    const bin = join(directory, "bin");
    const stableCwd = join(directory, "source");
    const logs = join(directory, "shared", "alice", "background");
    const driverState = join(directory, "isolated driver state");
    const python = join(directory, "custom Python", "bin", "python3");
    await mkdir(bin);
    await mkdir(stableCwd);
    const launchctl = join(bin, "launchctl");
    await writeFile(launchctl, '#!/bin/sh\nif [ "$1" = print ]; then exit 1; fi\nexit 0\n');
    await chmod(launchctl, 0o755);
    const script = resolve(import.meta.dir, "../scripts/launch-background.py");
    const child = Bun.spawn(["/usr/bin/python3", script, "--label", "dev.ludens.pet", "--log-dir", logs, "pet", "/bin/echo", "--workspace", "/tmp/seed workspace"], {
      cwd: stableCwd, env: { ...process.env, PATH: bin, RSA_WORKSPACE: "/tmp/stale",
        XDG_STATE_HOME: driverState, RSA_PYTHON: python,
        RSA_PERCEPTION_PERSIST: "0", RSA_PERCEPTION_HOT_SECONDS: "600" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const canonicalCwd = await realpath(stableCwd);
    const canonicalLogs = await realpath(logs);
    expect(JSON.parse(stdout)).toMatchObject({
      target: `gui/${process.getuid!()}/dev.ludens.pet`, workspace: canonicalCwd,
      log: join(canonicalLogs, "pet.log"), plist: join(canonicalLogs, "pet.plist"),
    });
    const plist = await readFile(join(logs, "pet.plist"), "utf8");
    expect(plist).toContain("<string>dev.ludens.pet</string>");
    expect(plist).toContain(`<key>WorkingDirectory</key>\n\t<string>${canonicalCwd}</string>`);
    expect(plist).toContain(`<string>${join(canonicalLogs, "pet.log")}</string>`);
    expect(plist).not.toContain("RSA_WORKSPACE");
    expect(plist).toContain(`<key>XDG_STATE_HOME</key>\n\t\t<string>${driverState}</string>`);
    expect(plist).toContain(`<key>RSA_PYTHON</key>\n\t\t<string>${python}</string>`);
    expect(plist).toContain("<key>RSA_PERCEPTION_PERSIST</key>\n\t\t<string>0</string>");
    expect(plist).toContain("<key>RSA_PERCEPTION_HOT_SECONDS</key>\n\t\t<string>600</string>");
    expect(await readdir(stableCwd)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an externally started emulator process blocks startup before spawning or stopping anything", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalEmulator = true;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[1] === "bootout" || argv[1] === "auto")).toBe(false);
});

test("emulator process matching treats custom executable paths as POSIX regex literals", async () => {
  const executable = "/tmp/Emulator (native)[1]+.app/Contents/MacOS/emulator";
  const manifest = { ...manifestFor("bridge-fixture"), launchCommand: [executable] };
  const value = await launchPlan(parseConfig({ driver: manifest.id, game: "game.rom" }, manifest),
    "/tmp/Literal path workspace", "/tmp/Source", "/tmp/literal-path.sock", manifest);
  for (const [existingCommand, matches] of [
    [executable, true],
    [`${executable} game.rom`, true],
    [`${executable}-helper game.rom`, false],
    ["/tmp/Emulator native11Xapp/Contents/MacOS/emulator game.rom", false],
  ] as const) {
    const io = new FakeServices(value);
    const run = io.run.bind(io);
    io.run = async (argv, cwd) => {
      if (argv[0] !== "pgrep") return run(argv, cwd);
      io.calls.push([...argv]);
      // Exercise the same POSIX ERE syntax as pgrep without inspecting or
      // starting any real emulator process, including lookalikes and prefixes.
      const matcher = Bun.spawn(["grep", "-E", argv[2]!], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      matcher.stdin.write(`${existingCommand}\n`);
      matcher.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        matcher.exited, new Response(matcher.stdout).text(), new Response(matcher.stderr).text(),
      ]);
      expect(stderr).toBe("");
      return { code, stdout, stderr };
    };
    if (matches) {
      await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
      expect(io.starts).toEqual([]);
    } else {
      expect((await new WorkspaceLauncher(value, io).up()).host?.mode).toBe("manual");
      expect(io.starts).toContain("emulator");
    }
  }
});

test("package launch wrappers cannot start another emulator on an externally occupied bridge", async () => {
  const value = await plan();
  value.commands.emulator = ["env", `RSA_BRIDGE_PORT=${value.config.port}`, "/external/package/launch.sh", "game.rom"];
  const io = new FakeServices(value);
  io.preparedBridgePid = 700;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already listening outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[1] === "bootout" || argv[1] === "auto")).toBe(false);
});

test("a bridge used by another workspace neither receives a second host nor gets stopped", async () => {
  const prepared = await launchPlan(parseConfig({ driver: "bridge-fixture" }, manifestFor("bridge-fixture")), "/tmp/Second workspace", undefined, "/tmp/second-baseware.sock", manifestFor("bridge-fixture"));
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
