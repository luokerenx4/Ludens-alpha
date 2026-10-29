import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriver } from "../src/drivers/loader.ts";

test("default driver cache uses Ludens home independently of checkout and XDG state", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-home-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", `import { defaultDriverCacheRoot } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/loader.ts"))}; console.log(defaultDriverCacheRoot());`], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LUDENS_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "unused-state") },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe(join(root, "home", "cache", "drivers"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serve has no implicit emulator and requires a package for emulator ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-explicit-"));
  try {
    for (const id of [undefined, "mgba", "azahar", "ryubing"]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "serve",
        ...(id ? ["--driver", id] : []), "--socket", join(root, "service.sock"), "--data-dir", join(root, "data")],
        { stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain(id ? "--driver-package" : "requires --driver");
      expect(await Bun.file(join(root, "service.sock")).exists()).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub caches preserve transport and record installed commits rather than requested tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-github-"));
  const repositories = join(root, "repositories");
  const sshRepositories = join(root, "ssh-repositories");
  const cache = join(root, "cache");
  await mkdir(repositories);
  await mkdir(sshRepositories);
  const git = async (directory: string, args: string[]) => {
    const child = Bun.spawn(["git", "-c", "user.name=Driver Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout.trim();
  };
  const commit = async (directory: string, version: string, tag: string) => {
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "github-fixture", main: "wrong.js", exports: { import: "./entry.js", require: "./wrong.js" },
    }));
    await writeFile(join(directory, "entry.js"), `export default { id: "fixture", version: ${JSON.stringify(version)}, load() {} };`);
    await writeFile(join(directory, "wrong.js"), 'throw new Error("wrong package entrypoint");');
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-m", version]);
    await git(directory, ["tag", tag]);
    return git(directory, ["rev-parse", "HEAD"]);
  };
  const resolve = async (spec: string, expectedCode = 0) => {
    const source = `import { resolveDriver } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/loader.ts"))};
      const registration = await resolveDriver("fixture", ${JSON.stringify(spec)}, ${JSON.stringify(cache)});
      console.log(JSON.stringify({ version: registration.version, source: registration.source }));`;
    const child = Bun.spawn([process.execPath, "--eval", source], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: `url.file://${repositories}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/org/",
        GIT_CONFIG_KEY_1: `url.file://${sshRepositories}/.insteadOf`, GIT_CONFIG_VALUE_1: "git@github.com:org/" } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(expectedCode);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  try {
    const one = join(repositories, "one.git");
    const two = join(repositories, "two.git");
    const sshOne = join(sshRepositories, "one.git");
    for (const directory of [one, two, sshOne]) {
      await mkdir(directory);
      await git(directory, ["init"]);
    }
    const first = await commit(one, "one-v1", "v1");
    const second = await commit(one, "one-v2", "v2");
    const other = await commit(two, "two-v1", "v1");
    const sshCommit = await commit(sshOne, "ssh-v1", "v1");
    expect(await resolve("org/one#v1")).toEqual({ version: "one-v1", source: { kind: "github", transport: "https",
      spec: "https://github.com/org/one.git#v1", repository: "https://github.com/org/one.git", requestedRevision: "v1", resolvedCommit: first } });
    expect(await resolve("org/one#v2")).toMatchObject({ version: "one-v2", source: { resolvedCommit: second } });
    expect(await resolve("org/two#v1")).toMatchObject({ version: "two-v1", source: { resolvedCommit: other } });
    // An HTTPS cache cannot satisfy SSH: the fixture deliberately serves another repository.
    expect(await resolve("git@github.com:org/one.git#v1")).toEqual({ version: "ssh-v1", source: { kind: "github", transport: "ssh",
      spec: "git@github.com:org/one.git#v1", repository: "git@github.com:org/one.git", requestedRevision: "v1", resolvedCommit: sshCommit } });
    // Canonical spelling must share the completed checkout, not fetch a new URL.
    expect(await resolve("https://github.com/ORG/one.git#v1")).toMatchObject({ version: "one-v1", source: { resolvedCommit: first } });
    await git(one, ["tag", "-f", "v1"]);
    expect(await resolve("org/one#v1")).toMatchObject({ version: "one-v1", source: { resolvedCommit: first } });
    expect(await resolve("org/one#later", 1)).toContain("fetch failed");
    await git(one, ["tag", "later"]);
    expect(await resolve("org/one#later")).toMatchObject({ version: "one-v2", source: { resolvedCommit: second } });
    const key = createHash("sha256").update("github:https:org/one#v1").digest("hex");
    await rm(join(cache, "fixture", key, "package/.git"), { recursive: true });
    expect(await resolve("org/one#v1", 1)).toContain("rev-parse failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("file provenance identifies the imported entry and cannot be supplied by the package", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "driver-source-")));
  try {
    const entry = join(root, "entry.ts");
    const first = 'export default { id: "fixture", version: "first", source: { kind: "github", resolvedCommit: "forged" }, load() {} };';
    await writeFile(entry, first);
    const initial = await resolveDriver("fixture", `file:${entry}`, root);
    expect(initial.source).toEqual({ kind: "file", spec: `file:${entry}`, entry: "entry.ts",
      entrySha256: createHash("sha256").update(first).digest("hex") });
    await writeFile(entry, 'export default { id: "fixture", version: "changed", load() {} };');
    const cached = await resolveDriver("fixture", `file:${entry}`, root);
    // Import caching means the loaded implementation remains the original bytes.
    expect(cached.version).toBe("first");
    expect(cached.source).toEqual(initial.source);

    const directory = join(root, "package");
    await mkdir(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "local-fixture", exports: "./provider.ts" }));
    const provider = 'export default { id: "fixture", load() {} };';
    await writeFile(join(directory, "provider.ts"), provider);
    expect((await resolveDriver("fixture", `file:${directory}`, root)).source).toEqual({ kind: "file", spec: `file:${directory}`,
      entry: "provider.ts", entrySha256: createHash("sha256").update(provider).digest("hex") });
    expect((await resolveDriver("cua", undefined, root)).source).toEqual({ kind: "builtin" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("npm provenance uses the installed package version rather than the requested range", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-npm-source-"));
  try {
    const identity = "npm:fixture-driver@^1.0.0";
    const cached = join(root, "fixture", createHash("sha256").update(identity).digest("hex"));
    const directory = join(cached, "node_modules/fixture-driver");
    await mkdir(directory, { recursive: true });
    await writeFile(join(cached, ".complete"), identity);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture-driver", version: "1.4.2", main: "entry.js" }));
    await writeFile(join(directory, "entry.js"), 'export default Object.freeze(new class { id = "fixture"; #version = "device-7"; get version() { return this.#version; } async load() { return { version: this.#version }; } });');
    const driver = await resolveDriver("fixture", "fixture-driver@^1.0.0", root);
    expect(driver.source).toEqual({ kind: "npm", spec: identity, packageName: "fixture-driver", resolvedVersion: "1.4.2" });
    expect(driver.version).toBe("device-7");
    expect((await driver.load({ clock: { id: "fixture", now: () => 0 } })).version).toBe("device-7");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discover CLI imports registration without loading devices and rejects invalid manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-discover-"));
  const good = join(root, "good.ts");
  const bad = join(root, "bad.ts");
  const marker = join(root, "imported");
  await writeFile(good, `await Bun.write(${JSON.stringify(marker)}, "import ran");
    export default { id: "fixture", transport: "bridge", defaultPort: 47111, version: "1.0",
    launchHint: "hint", async load() { throw new Error("discover must not call load()"); } };`);
  await writeFile(bad, `export default { version: "1.0" };`);
  const run = async (spec: string, expectedCode = 0) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "driver", "discover", "--package", spec],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, LUDENS_HOME: join(root, "home") } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(expectedCode);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  try {
    expect(await run(`file:${good}`)).toEqual({ id: "fixture", transport: "bridge", defaultPort: 47111, version: "1.0", launchHint: "hint" });
    expect(await readFile(marker, "utf8")).toBe("import ran");
    expect(await run(`file:${bad}`, 1)).toContain("registration");
    expect(await run(`file:${join(root, "missing.ts")}`, 1)).toContain("Driver path not found");
    for (const [field, value] of [["id", "../escape"], ["version", {}], ["fallbackVersion", 42], ["defaultPort", 70000]] as const) {
      await writeFile(bad, `export default { id: "fixture", load() {}, ${field}: ${JSON.stringify(value)} };`);
      expect(await run(`file:${bad}`, 1)).toContain(field === "id" ? "Invalid driver id" : `invalid ${field}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const explicitDataDir of [false, true]) test(`serve publishes driver metadata with ${explicitDataDir ? "explicit" : "global default"} log directory`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "driver-serve-")));
  const entry = join(import.meta.dir, "../src/main.ts");
  const driver = join(root, "driver.ts");
  await writeFile(driver, `export default {
    id: "fixture", transport: "bridge", version: "3.2.1",
    launchEnv: { DOTNET_DefaultStackSize: "200000" },
    async load(options) {
      if (options.port !== 45678) throw new Error("Explicit port was not forwarded");
      return { capabilities: { controllers: [] }, onDisconnect() {}, close() {} };
    }
  };`);
  const socket = join(root, "service.sock");
  const home = join(root, "home");
  const dataDir = explicitDataDir ? join(root, "data") : join(home, "logs", "baseware", "service");
  const child = Bun.spawn([process.execPath, entry, "serve", "--driver", "fixture", "--driver-package", `file:${driver}`,
    "--port", "45678", "--socket", socket, ...(explicitDataDir ? ["--data-dir", dataDir] : [])], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, LUDENS_HOME: home },
    });
  const serviceError = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    if (ready.done) throw new Error(`Fixture service exited before ready: ${await serviceError}`);
    const readyState = JSON.parse(new TextDecoder().decode(ready.value));
    expect(readyState.ready).toBe(true);
    expect(readyState.dataDir).toBe(dataDir);
    reader.releaseLock();
    const list = Bun.spawn([process.execPath, entry, "driver", "list"], {
      env: { ...process.env, BASEWARE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([list.exited, new Response(list.stdout).text(), new Response(list.stderr).text()]);
    expect(code, stderr).toBe(0);
    const source = { kind: "file", spec: `file:${driver}`, entry: "driver.ts",
      entrySha256: createHash("sha256").update(await readFile(driver)).digest("hex") };
    expect(JSON.parse(stdout)).toEqual([{ id: "fixture", transport: "bridge", version: "3.2.1", launchEnv: { DOTNET_DefaultStackSize: "200000" }, source }]);
    const [serviceId] = await readdir(dataDir);
    const events = join(dataDir, serviceId!, "events");
    const lines = await Promise.all((await readdir(events)).filter(name => name.endsWith(".jsonl")).map(name => readFile(join(events, name), "utf8")));
    const start = lines.flatMap(text => text.trim().split("\n").map(line => JSON.parse(line))).find(event => event.type === "service_start");
    expect(start.data.driverSource).toEqual(source);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
