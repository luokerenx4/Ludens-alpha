import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorkspaceIdentity, forgetWorkspace, listRegisteredWorkspaces, readGlobalConfig,
  readWorkspaceIdentity, registerWorkspace, renewWorkspaceIdentity, updateGlobalConfig, writeGlobalConfig } from "../../shared/ludens.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-layout-")));
  const home = join(root, "application"), cwd = join(root, "caller");
  await mkdir(cwd);
  const run = async (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
    delete env.RSA_WORKSPACE; delete env.RSA_SOCKET; delete env.BASEWARE_SOCKET;
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { root, home, cwd, run, close: () => rm(root, { recursive: true, force: true }) };
}

test("new workspaces use the configured parent or an explicit path and snapshot global defaults", async () => {
  const f = await fixture();
  try {
    expect((await f.run("config", "show")).code).toBe(0);
    expect((await f.run("init", "--driver", "cua")).stderr).toContain("Use --name");
    expect(await readdir(f.cwd)).toEqual([]);
    const parent = join(f.root, "chosen parent");
    expect((await f.run("config", "set", "workspaceRoot", parent)).code).toBe(0);
    expect((await f.run("config", "set", "defaults.seconds", "701")).code).toBe(0);
    expect((await f.run("config", "set", "defaults.pet", "true")).code).toBe(0);
    const created = await f.run("init", "--name", "first", "--driver", "cua", "--no-pet");
    expect(created.code, created.stderr).toBe(0);
    const first = JSON.parse(created.stdout);
    expect(first.workspace).toBe(join(parent, "first"));
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ seconds: 701, pet: false });
    expect((await f.run("config", "set", "defaults.seconds", "999")).code).toBe(0);
    const second = await f.run("init", "--name", "second", "--driver", "cua");
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(await readFile(JSON.parse(second.stdout).configPath, "utf8"))).toMatchObject({ seconds: 999, pet: true });
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ seconds: 701, pet: false });
    const outside = join(f.root, "external folder");
    const explicit = await f.run("init", "--workspace", outside, "--driver", "cua");
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout).workspace).toBe(outside);
    const prefix = await f.run("--workspace", join(f.root, "prefix"), "init", "--driver", "cua");
    expect(prefix.code, prefix.stderr).toBe(0);
    expect((await listRegisteredWorkspaces(f.home)).length).toBe(4);
    expect((await f.run("init", "--name", "../escape", "--driver", "cua")).code).toBe(1);
    expect((await f.run("init", "--name", "first", "--driver", "cua")).stderr).toContain("EEXIST");
  } finally { await f.close(); }
});

test("invalid global settings never overwrite the saved configuration", async () => {
  const f = await fixture();
  try {
    expect(await readGlobalConfig(f.home)).toEqual({ version: 1, workspaceRoot: join(f.home, "workspaces"), defaults: {} });
    await writeGlobalConfig({ version: 1, workspaceRoot: f.cwd, defaults: { model: "fixture/model", requests: 5 } }, f.home);
    const before = await readFile(join(f.home, "config.json"), "utf8");
    for (const [key, value] of [["defaults.pet", "yes"], ["defaults.seconds", "0"], ["defaults.requests", "1.5"], ["defaults.unknown", "1"]]) {
      expect((await f.run("config", "set", key!, value!)).code).toBe(1);
      expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(before);
    }
  } finally { await f.close(); }
});

test("concurrent CLI and process config edits keep independently changed fields", async () => {
  const f = await fixture();
  const entry = resolve(import.meta.dir, "../../shared/ludens.ts");
  const child = Bun.spawn([process.execPath, "--eval", `
    import { updateGlobalConfig } from ${JSON.stringify(entry)};
    await updateGlobalConfig(async config => {
      console.log("locked");
      await Bun.stdin.text();
      return { ...config, defaults: { ...config.defaults, seconds: 701 } };
    }, ${JSON.stringify(f.home)});
  `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const error = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    const edits = Promise.all([f.run("config", "set", "defaults.pet", "true"), f.run("config", "set", "defaults.requests", "73")]);
    // The first process keeps its read snapshot while other clients reach the lock.
    await Bun.sleep(150);
    child.stdin.end();
    expect(await child.exited, await error).toBe(0);
    for (const result of await edits) expect(result.code, result.stderr).toBe(0);
    expect((await readGlobalConfig(f.home)).defaults).toEqual({ seconds: 701, pet: true, requests: 73 });
    const before = await readFile(join(f.home, "config.json"), "utf8");
    await expect(updateGlobalConfig(() => { throw new Error("cancelled edit"); }, f.home)).rejects.toThrow("cancelled edit");
    expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(before);
    expect((await readdir(f.home)).filter(name => name.includes(".lock"))).toEqual([]);
  } finally { child.kill(); await child.exited; await f.close(); }
});

test("exited lock owners are recovered without competing recoverers deleting a new owner's lock", async () => {
  const f = await fixture();
  const entry = resolve(import.meta.dir, "../../shared/ludens.ts");
  const crashed = Bun.spawn([process.execPath, "--eval", `
    import { updateGlobalConfig } from ${JSON.stringify(entry)};
    await updateGlobalConfig(async config => { console.log("locked"); await Bun.stdin.text(); return config; }, ${JSON.stringify(f.home)});
  `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const workers: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const reader = crashed.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    crashed.kill("SIGKILL"); await crashed.exited;
    expect(() => process.kill(crashed.pid, 0)).toThrow();
    expect(await readdir(join(f.home, "config.json.lock"))).toHaveLength(1);
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { updateGlobalConfig } from ${JSON.stringify(entry)};
        await updateGlobalConfig(async config => {
          await Bun.sleep(25);
          return { ...config, defaults: { ...config.defaults, requests: (config.defaults.requests ?? 0) + 1 } };
        }, ${JSON.stringify(f.home)});
      `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
      workers.push(child);
      return { code: await child.exited, stderr: await new Response(child.stderr).text() };
    }));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    expect((await readGlobalConfig(f.home)).defaults.requests).toBe(8);
    expect((await readdir(f.home)).filter(name => name.includes(".lock"))).toEqual([]);

    const workspace = join(f.root, "workspace"); await mkdir(workspace);
    const identity = await ensureWorkspaceIdentity(workspace);
    const staleRegistryLock = join(f.home, "registry", `${identity.id}.json.lock`);
    await mkdir(staleRegistryLock, { recursive: true });
    await writeFile(join(staleRegistryLock, `owner-${crashed.pid}-${randomUUID()}`), "");
    expect((await registerWorkspace(workspace, f.home)).id).toBe(identity.id);
    expect((await readdir(join(f.home, "registry"))).filter(name => name.includes(".lock"))).toEqual([]);
  } finally {
    crashed.kill(); await crashed.exited;
    for (const child of workers) { child.kill(); await child.exited; }
    await f.close();
  }
});

test("workspace identity survives moves and index loss; unavailable and forgotten entries never delete data", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), moved = join(f.root, "moved");
    await mkdir(original);
    const [one, two] = await Promise.all([ensureWorkspaceIdentity(original), ensureWorkspaceIdentity(original)]);
    expect(one.id).toBe(two.id);
    await writeFile(join(original, "rsa.json"), '{"driver":"cua"}');
    await writeFile(join(original, "important.txt"), "preserved");
    await registerWorkspace(original, f.home);
    await rename(original, moved);
    expect(await listRegisteredWorkspaces(f.home)).toMatchObject([{ id: one.id, available: false }]);
    const reopened = await f.run("workspace", "open", moved);
    expect(reopened.code, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({ id: one.id, workspace: moved });
    await forgetWorkspace(one.id, f.home);
    expect(await listRegisteredWorkspaces(f.home)).toEqual([]);
    expect(await readFile(join(moved, "important.txt"), "utf8")).toBe("preserved");
    await rm(f.home, { recursive: true });
    expect((await registerWorkspace(moved, f.home)).id).toBe(one.id);
  } finally { await f.close(); }
});

test("independent copies require a new identity and retain explicit archive ownership", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), copy = join(f.root, "copy");
    await mkdir(original);
    const first = await ensureWorkspaceIdentity(original);
    await writeFile(join(original, "rsa.json"), '{"driver":"cua"}');
    await mkdir(join(original, ".rsa/shiori"), { recursive: true });
    await writeFile(join(original, ".rsa/shiori/current-session.json"), JSON.stringify({ sessionFile: "sessions/old.jsonl" }));
    await registerWorkspace(original, f.home);
    await cp(original, copy, { recursive: true });
    expect((await f.run("workspace", "open", copy)).stderr).toContain("--new-id");
    const reopened = await f.run("workspace", "open", copy, "--new-id");
    expect(reopened.code, reopened.stderr).toBe(0);
    const second = await readWorkspaceIdentity(copy);
    expect(second.id).not.toBe(first.id);
    expect(second.historyIds).toEqual([first.id]);
    expect((await readWorkspaceIdentity(original)).id).toBe(first.id);
    expect(await Bun.file(join(copy, ".rsa/shiori/current-session.json")).exists()).toBe(false);
    expect(await Bun.file(join(original, ".rsa/shiori/current-session.json")).exists()).toBe(true);
    expect((await listRegisteredWorkspaces(f.home)).length).toBe(2);
    const third = await renewWorkspaceIdentity(copy, f.home);
    expect(third.historyIds).toEqual([second.id, first.id]);
  } finally { await f.close(); }
});

test("a workspace-relative community package remains portable in saved configuration", async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, "with-driver");
    await mkdir(join(workspace, "driver"), { recursive: true });
    await writeFile(join(workspace, "driver/index.ts"), 'export default { id: "fixture", transport: "bridge", defaultPort: 45678, load() { throw new Error("must not load"); } };');
    const result = await f.run("init", "--workspace", workspace, "--driver", "fixture", "--driver-package", "file:./driver/index.ts");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(workspace, "rsa.json"), "utf8")).driverPackage).toBe("file:./driver/index.ts");
    const moved = join(f.root, "moved-driver");
    await rename(workspace, moved);
    const preview = await f.run("--workspace", moved, "up", "--dry-run");
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).commands.baseware).toContain(`file:${moved}/driver/index.ts`);
  } finally { await f.close(); }
});

test("concurrent first registration cannot silently claim two copies of the same workspace", async () => {
  const f = await fixture();
  try {
    const one = join(f.root, "one"), two = join(f.root, "two");
    await mkdir(one);
    await ensureWorkspaceIdentity(one);
    await cp(one, two, { recursive: true });
    const results = await Promise.allSettled([registerWorkspace(one, f.home), registerWorkspace(two, f.home)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await listRegisteredWorkspaces(f.home)).toHaveLength(1);
    expect((await readdir(join(f.home, "registry"))).some(name => name.endsWith(".lock"))).toBe(false);
  } finally { await f.close(); }
});
