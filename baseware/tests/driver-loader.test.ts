import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GitHub caches distinguish real repositories and revisions and retry failed checkouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-github-"));
  const repositories = join(root, "repositories");
  const cache = join(root, "cache");
  await mkdir(repositories);
  const git = async (directory: string, args: string[]) => {
    const child = Bun.spawn(["git", "-c", "user.name=Driver Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
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
  };
  const resolve = async (spec: string, expectedCode = 0) => {
    const source = `import { resolveDriver } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/loader.ts"))};
      const registration = await resolveDriver("fixture", ${JSON.stringify(spec)}, ${JSON.stringify(cache)});
      console.log(JSON.stringify(registration.version));`;
    const child = Bun.spawn([process.execPath, "--eval", source], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${repositories}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/org/" } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(expectedCode);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  try {
    const one = join(repositories, "one.git");
    const two = join(repositories, "two.git");
    for (const directory of [one, two]) {
      await mkdir(directory);
      await git(directory, ["init"]);
    }
    await commit(one, "one-v1", "v1");
    await commit(one, "one-v2", "v2");
    await commit(two, "two-v1", "v1");
    expect(await resolve("org/one#v1")).toBe("one-v1");
    expect(await resolve("org/one#v2")).toBe("one-v2");
    expect(await resolve("org/two#v1")).toBe("two-v1");
    // Canonical spelling must share the completed checkout, not fetch a new URL.
    expect(await resolve("https://github.com/ORG/one.git#v1")).toBe("one-v1");
    expect(await resolve("org/one#later", 1)).toContain("fetch failed");
    await git(one, ["tag", "later"]);
    expect(await resolve("org/one#later")).toBe("one-v2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("discover validates file packages without knowing the driver id and rejects invalid exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-discover-"));
  const good = join(root, "good.ts");
  const bad = join(root, "bad.ts");
  await writeFile(good, `export default { id: "fixture", transport: "bridge", defaultPort: 47111, version: "1.0",
    launchHint: "hint", async load() { return { capabilities: { controllers: [] }, onDisconnect() {}, close() {} }; } };`);
  await writeFile(bad, `export default { version: "1.0" };`);
  const source = (spec: string) => `import { discoverDriver } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/loader.ts"))};
    const r = await discoverDriver(${JSON.stringify(spec)}, ${JSON.stringify(join(root, "cache"))});
    if (typeof r.load !== "function") throw new Error("discover must not strip load()");
    console.log(JSON.stringify({ id: r.id, transport: r.transport, defaultPort: r.defaultPort, version: r.version, launchHint: r.launchHint }));`;
  const run = async (spec: string, expectedCode = 0) => {
    const child = Bun.spawn([process.execPath, "--eval", source(spec)], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(expectedCode);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  try {
    expect(await run(`file:${good}`)).toEqual({ id: "fixture", transport: "bridge", defaultPort: 47111, version: "1.0", launchHint: "hint" });
    expect(await run(`file:${bad}`, 1)).toContain("registration");
    expect(await run(`file:${join(root, "missing.ts")}`, 1)).toContain("Driver path not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serve forwards explicit bridge ports without defaults and publishes registration version and launch environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-serve-"));
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
  const child = Bun.spawn([process.execPath, entry, "serve", "--driver", "fixture", "--driver-package", `file:${driver}`,
    "--port", "45678", "--socket", socket, "--data-dir", join(root, "data")], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('"ready":true');
    reader.releaseLock();
    const list = Bun.spawn([process.execPath, entry, "driver", "list"], {
      env: { ...process.env, BASEWARE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([list.exited, new Response(list.stdout).text(), new Response(list.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ id: "fixture", transport: "bridge", version: "3.2.1", launchEnv: { DOTNET_DefaultStackSize: "200000" } }]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
