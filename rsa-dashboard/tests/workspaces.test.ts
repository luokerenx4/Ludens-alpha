import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSettings, updateWorkspaceRoot, openWorkspace, removeWorkspace, createWorkspace } from "../lib/workspaces";
import { readGlobalConfig, writeGlobalConfig } from "../../shared/ludens";
import { setPetTarget, petState } from "../lib/pet-state";
import { registerFixture } from "./fixtures/registry";
import { DashboardWorker } from "../lib/dashboard-worker";
import { POST, PUT, DELETE } from "../app/api/workspaces/route";

test("workspace management preserves defaults, missing registrations, files, and the import boundary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-management-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), parent = join(root, "new-workspaces");
  try {
    await writeGlobalConfig({ version: 1, workspaceRoot: join(home, "workspaces"), defaults: { seconds: 77, pet: false } }, home);
    const registered = await registerFixture(home, "fixture", workspace);
    await writeFile(join(workspace, "keep.txt"), "retained");
    await setPetTarget(registered.id, false, home);
    const updated = await updateWorkspaceRoot(parent, home);
    assert.equal(updated.home, home);
    assert.equal(updated.config.workspaceRoot, parent);
    assert.deepEqual(updated.config.defaults, { seconds: 77, pet: false });
    assert.equal(updated.workspaces[0].workspace, workspace);
    await assert.rejects(updateWorkspaceRoot("relative", home), /绝对路径/);
    const old = join(root, "old-directory"); await mkdir(old);
    await assert.rejects(openWorkspace(old, home), /import/);
    await assert.rejects(readFile(join(old, ".rsa/workspace.json")), { code: "ENOENT" });
    await removeWorkspace(registered.id, home);
    assert.deepEqual((await workspaceSettings(home)).workspaces, []);
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "retained");
    assert.equal((await petState(home)).target, null);
    assert.equal((await openWorkspace(workspace, home)).id, registered.id);
    await rm(workspace, { recursive: true });
    assert.equal((await workspaceSettings(home)).workspaces[0].available, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creating through the CLI uses the global default or explicit directory without starting services", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-create-"))), home = join(root, "home");
  const inherited = { RSA_WORKSPACE: process.env.RSA_WORKSPACE, RSA_SOCKET: process.env.RSA_SOCKET,
    BASEWARE_DRIVER_PACKAGES: process.env.BASEWARE_DRIVER_PACKAGES, BASEWARE_SOCKET: process.env.BASEWARE_SOCKET };
  try {
    Object.assign(process.env, { RSA_WORKSPACE: join(root, "unrelated-workspace"), RSA_SOCKET: join(root, "unrelated-rsa.sock"),
      BASEWARE_DRIVER_PACKAGES: "/nonexistent/inherited-driver", BASEWARE_SOCKET: join(root, "unrelated-baseware.sock") });
    const before = await readGlobalConfig(home);
    await writeGlobalConfig({ ...before, defaults: { seconds: 79, requests: 13, pet: false } }, home);
    const created = await createWorkspace({ name: "one", driver: "cua" }, undefined, home);
    assert.equal(created.workspace, join(home, "workspaces/one"));
    assert.deepEqual((await workspaceSettings(home)).workspaces.map(entry => entry.id), [created.id]);
    const config = JSON.parse(await readFile(join(created.workspace, "rsa.json"), "utf8"));
    assert.equal(config.seconds, 79); assert.equal(config.requests, 13); assert.equal(config.pet, false);
    await assert.rejects(readFile(join(created.workspace, "logs/background/host.plist")), { code: "ENOENT" });
    const explicit = join(root, "custom path");
    assert.equal((await createWorkspace({ name: "two", workspace: explicit, driver: "cua" }, undefined, home)).workspace, explicit);
    await assert.rejects(createWorkspace({ name: "../escape", driver: "cua" }, undefined, home), /名称/);
    await assert.rejects(createWorkspace({ name: "bad", driver: "cua", extra: "unexpected" }, undefined, home), /字段/);
    await assert.rejects(createWorkspace({ name: "one", driver: "cua" }, undefined, home), /exist|已有|EEXIST/i);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace API rejects cross-origin writes and worker reports its actual home", async () => {
  for (const [method, handler] of [["POST", POST], ["PUT", PUT], ["DELETE", DELETE]] as const) {
    const response = await handler(new Request("http://localhost:3015/api/workspaces", { method,
      headers: { host: "localhost:3015", origin: "https://outside.invalid", "content-type": "application/json" }, body: "{}" }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /同源/);
  }
  const home = await realpath(await mkdtemp(join(tmpdir(), "ludens-api-home-")));
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  try {
    const response = await worker.call("workspaceSettings", []);
    assert.equal(response.home, home);
    assert.equal(response.config.workspaceRoot, join(home, "workspaces"));
    assert.deepEqual(response.workspaces, []);
  } finally { await worker.close(); await rm(home, { recursive: true, force: true }); }
});
