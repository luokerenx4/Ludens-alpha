import { registerFixture } from "./fixtures/registry";
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perceptionSettings, updatePerceptionSettings } from "../lib/perception-config";
import { clearCatalogCache } from "../lib/data";
import { DashboardWorker } from "../lib/dashboard-worker";
import * as route from "../app/api/perception-config/route";
import { withWorkspaceRegistrationLock } from "../../shared/ludens";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "perception-config-")));
  const root = join(base, "home"), workspace = join(base, "workspace");
  await mkdir(workspace);
  await registerFixture(root, "registered", workspace);
  return { base, root, workspace, path: join(workspace, ".rsa/settings.json"),
    cleanup: async () => { clearCatalogCache(); await rm(base, { recursive: true, force: true }); } };
}

test("new registered workspaces read inherited settings and the worker saves and explicitly resets overrides", async () => {
  const f = await fixture();
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: f.root } });
  try {
    assert.deepEqual(await worker.call("perceptionSettings", ["registered", f.workspace]), {});
    await assert.rejects(access(f.path));
    assert.deepEqual(await worker.call("updatePerceptionSettings", ["registered", { hotSeconds: 120, videoIdleSeconds: 20 }, f.workspace]),
      { hotSeconds: 120, videoIdleSeconds: 20 });
    const reset = JSON.parse(JSON.stringify({ hotSeconds: null }));
    assert.deepEqual(await worker.call("updatePerceptionSettings", ["registered", reset, f.workspace]), { videoIdleSeconds: 20 });
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { videoIdleSeconds: 20 });
    await assert.rejects(worker.call("updatePerceptionSettings", ["missing", { hotSeconds: 120 }, f.workspace]), /未找到|ENOENT/);
  } finally { await worker.close(); await f.cleanup(); }
});

test("concurrent saves retain every field and leave one complete JSON file", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      updatePerceptionSettings("registered", { hotSeconds: 120 }, f.workspace, f.root),
      updatePerceptionSettings("registered", { videoSegmentSeconds: 240 }, f.workspace, f.root),
      updatePerceptionSettings("registered", { videoIdleSeconds: 30 }, f.workspace, f.root),
    ]);
    const expected = { hotSeconds: 120, videoSegmentSeconds: 240, videoIdleSeconds: 30 };
    assert.deepEqual(await perceptionSettings("registered", f.workspace, f.root), expected);
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), expected);
    assert.deepEqual((await readdir(join(f.workspace, ".rsa"))).sort(), ["settings.json", "workspace.json"]);
    await writeFile(f.path, "broken JSON");
    await assert.rejects(updatePerceptionSettings("registered", { hotSeconds: 180 }, f.workspace, f.root), /JSON|Unexpected/);
    await writeFile(f.path, JSON.stringify(expected));
    assert.equal((await updatePerceptionSettings("registered", { hotSeconds: 180 }, f.workspace, f.root)).hotSeconds, 180);
  } finally { await f.cleanup(); }
});

test("readback waits for an already queued save rather than confirming the previous disk values", async () => {
  const f = await fixture();
  let release!: () => void, acquired!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { acquired = resolve; });
  const lock = withWorkspaceRegistrationLock(f.root, "registered", async () => { acquired(); await held; });
  try {
    await locked;
    const saving = updatePerceptionSettings("registered", { hotSeconds: 180 }, f.workspace, f.root);
    // Seeing the pending lock directory proves this save has entered the queue;
    // no arbitrary delay is used to decide when the read may start.
    const deadline = Date.now() + 2000;
    while (!(await readdir(join(f.root, "registry"))).some(name => name.startsWith("registered.json.lock.pending-"))) {
      assert.ok(Date.now() < deadline, "save reached its registration lock");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    let readSettled = false;
    const reading = perceptionSettings("registered", f.workspace, f.root).finally(() => { readSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(readSettled, false);
    release();
    assert.deepEqual(await saving, { hotSeconds: 180 });
    assert.deepEqual(await reading, { hotSeconds: 180 });
  } finally { release(); await lock; await f.cleanup(); }
});

test("custom positive seconds remain readable and unrelated file settings survive UI patches", async () => {
  const f = await fixture();
  try {
    const custom = { hotSeconds: 0.5, videoSegmentSeconds: 7200, videoIdleSeconds: null, userSetting: { value: true } };
    await writeFile(f.path, JSON.stringify(custom));
    assert.deepEqual(await perceptionSettings("registered", f.workspace, f.root), { hotSeconds: 0.5, videoSegmentSeconds: 7200 });
    assert.deepEqual(await updatePerceptionSettings("registered", { videoIdleSeconds: 2 }, f.workspace, f.root),
      { hotSeconds: 0.5, videoSegmentSeconds: 7200, videoIdleSeconds: 2 });
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { ...custom, videoIdleSeconds: 2 });
    for (const patch of [{ hotSeconds: true }, { hotSeconds: 0.5 }, { hotSeconds: 7200 }, { videoIdleSeconds: 0 }, { other: 10 }])
      await assert.rejects(updatePerceptionSettings("registered", patch, f.workspace, f.root), /设置/);
    await writeFile(f.path, JSON.stringify({ hotSeconds: true }));
    await assert.rejects(perceptionSettings("registered", f.workspace, f.root), /正数/);
  } finally { await f.cleanup(); }
});

test("settings paths reject symlinks and saves do not follow a predictable temporary filename", async () => {
  const f = await fixture();
  try {
    const outside = join(f.base, "outside"), directory = join(f.workspace, ".rsa");
    await mkdir(outside);
    const externalFile = join(outside, "settings.json"), original = '{"hotSeconds": 90}\n';
    await writeFile(externalFile, original);
    const identity = await readFile(join(directory, "workspace.json"));
    await writeFile(join(outside, "workspace.json"), identity);
    await rm(directory, { recursive: true });
    await symlink(outside, directory);
    await assert.rejects(perceptionSettings("registered", f.workspace, f.root), /真实目录/);
    await assert.rejects(updatePerceptionSettings("registered", { hotSeconds: 120 }, f.workspace, f.root), /真实目录/);
    await rm(directory);
    await mkdir(directory);
    await writeFile(join(directory, "workspace.json"), identity);
    await symlink(externalFile, f.path);
    await assert.rejects(perceptionSettings("registered", f.workspace, f.root), /普通文件/);
    await assert.rejects(updatePerceptionSettings("registered", { hotSeconds: 120 }, f.workspace, f.root), /普通文件/);
    await rm(f.path);
    await symlink(externalFile, f.path + ".tmp");
    assert.deepEqual(await updatePerceptionSettings("registered", { hotSeconds: 120 }, f.workspace, f.root), { hotSeconds: 120 });
    assert.equal(await readFile(externalFile, "utf8"), original);
  } finally { await f.cleanup(); }
});

test("the settings route rejects foreign origins and invalid patches before dispatching a mutation", async () => {
  const request = (body: unknown, origin?: string) => new Request("http://localhost:3015/api/perception-config?project=registered", {
    method: "PUT", headers: { host: "localhost:3015", "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  for (const origin of [undefined, "https://untrusted.test"]) {
    const response = await route.PUT(request({ hotSeconds: null }, origin));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /同源/);
  }
  for (const body of [null, [], { hotSeconds: "120" }, { hotSeconds: -1 }, { hotSeconds: 1e9 }, { __proto__: null, unexpected: 1 }]) {
    const response = await route.PUT(request(body, "http://localhost:3015"));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /设置/);
  }
});
