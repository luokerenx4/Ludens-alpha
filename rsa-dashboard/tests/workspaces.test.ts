import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSettings, updateWorkspaceRoot, openWorkspace, removeWorkspace, createWorkspace } from "../lib/workspaces";
import { readGlobalConfig, writeGlobalConfig, registeredWorkspace, registerWorkspace, forgetWorkspace,
  withPetTargetLock } from "../../shared/ludens";
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
    assert.equal(updated.config.workspaceRoot, parent);
    assert.deepEqual(updated.config.defaults, { seconds: 77, pet: false });
    await assert.rejects(updateWorkspaceRoot("relative", home), /绝对路径/);
    const old = join(root, "old-directory"); await mkdir(old);
    await assert.rejects(openWorkspace(old, home), /import/);
    await assert.rejects(readFile(join(old, ".rsa/workspace.json")), { code: "ENOENT" });
    assert.deepEqual((await removeWorkspace(registered.id, home)).removed, registered);
    assert.deepEqual((await workspaceSettings(home)).workspaces, []);
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "retained");
    assert.equal((await petState(home)).target, null);
    assert.equal((await openWorkspace(workspace, home)).id, registered.id);
    assert.equal((await petState(home)).target, null);
    await rm(workspace, { recursive: true });
    assert.equal((await workspaceSettings(home)).workspaces[0].available, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("committed root/removal results do not depend on catalog or consumer reads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-committed-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), destination = join(root, "new-root");
  try {
    const registered = await registerFixture(home, "selected", workspace);
    await setPetTarget(registered.id, false, home);
    // These make the old post-commit workspaceSettings/petState reads fail.
    await writeFile(join(home, "registry/unrelated.json"), "{");
    await writeFile(join(home, "pet/consumer.json"), "{");
    const saved = await updateWorkspaceRoot(destination, home);
    assert.equal(saved.config.workspaceRoot, destination);
    assert.equal((await readGlobalConfig(home)).workspaceRoot, destination);
    const removed = await removeWorkspace(registered.id, home);
    assert.deepEqual(removed, { removed: registered });
    await assert.rejects(registeredWorkspace(registered.id, home), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    assert.deepEqual(await removeWorkspace(registered.id, home), { removed: null });
    await assert.rejects(workspaceSettings(home), SyntaxError, "the independent refresh still reports its genuine failure");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("removal returns the current registration for Undo and preserves an unrelated offline target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removed-entry-")));
  const home = join(root, "home"), original = join(root, "original"), moved = join(root, "moved"), other = join(root, "other");
  try {
    const stale = await registerFixture(home, "selected", original);
    const unrelated = await registerFixture(home, "other", other);
    await setPetTarget(unrelated.id, false, home);
    const rawTarget = await readFile(join(home, "pet/target.json"), "utf8");
    await rm(other, { recursive: true });
    await rename(original, moved);
    const current = await registerWorkspace(moved, home);
    assert.notEqual(current.workspace, stale.workspace);
    const result = await removeWorkspace(stale.id, home);
    assert.deepEqual(result.removed, current, "Undo gets the removed path, not a stale UI row");
    assert.equal(await readFile(join(home, "pet/target.json"), "utf8"), rawTarget);
    assert.deepEqual(await registeredWorkspace(unrelated.id, home), unrelated);
    await openWorkspace(result.removed!.workspace, home);
    assert.equal(await readFile(join(home, "pet/target.json"), "utf8"), rawTarget);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unreadable target blocks removal before unlink and permits explicit recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-blocked-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    const path = join(home, "pet/target.json"), original = await readFile(path, "utf8");
    await writeFile(path, "{");
    await assert.rejects(removeWorkspace(entry.id, home), error => {
      assert.equal((error as any).code, "WORKSPACE_REMOVAL_BLOCKED");
      assert.match((error as Error).message, /仍在列表中/); return true;
    });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    await rm(path); await mkdir(path);
    await assert.rejects(forgetWorkspace(entry.id, home), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    await rm(path, { recursive: true }); await writeFile(path, original);
    assert.deepEqual(await forgetWorkspace(entry.id, home), entry, "shared CLI primitive has the same safe order");
    assert.equal(JSON.parse(await readFile(path, "utf8")), null);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null, "shared re-registration does not revive follow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed target write leaves registration and the original target intact", { skip: process.getuid?.() === 0 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-write-failure-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), pet = join(home, "pet");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    const target = await readFile(join(pet, "target.json"), "utf8");
    // The readable target remains in place; publishing its null replacement is
    // denied. The registry lives in a separate, still writable directory.
    await chmod(pet, 0o500);
    await assert.rejects(removeWorkspace(entry.id, home), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    assert.equal(await readFile(join(pet, "target.json"), "utf8"), target);
    await chmod(pet, 0o700);
    assert.deepEqual((await removeWorkspace(entry.id, home)).removed, entry);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null);
  } finally { await chmod(pet, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("a queued follow revalidates after removal and cannot revive its target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-race-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    let releaseTarget!: () => void, targetLocked!: () => void;
    const targetReady = new Promise<void>(resolve => { targetLocked = resolve; });
    const targetHold = withPetTargetLock(home, async () => { targetLocked(); await new Promise<void>(resolve => { releaseTarget = resolve; }); });
    await targetReady;
    const removing = removeWorkspace(entry.id, home);
    // Wait until deletion owns its registry lock and is blocked on the target.
    let locked = false;
    for (let attempt = 0; attempt < 100 && !locked; attempt++) {
      locked = await readFile(join(home, `registry/${entry.id}.json.lock`)).then(() => false, error => error.code === "EISDIR");
      if (!locked) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(locked, "removal reached the ordered lock boundary");
    const following = setPetTarget(entry.id, false, home);
    const rejected = assert.rejects(following, /未找到已登记/);
    releaseTarget(); await targetHold;
    assert.deepEqual((await removing).removed, entry); await rejected;
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent follow of another workspace survives removal", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-other-follow-race-")));
  const home = join(root, "home");
  try {
    const removed = await registerFixture(home, "removed", join(root, "removed"));
    const other = await registerFixture(home, "other", join(root, "other"));
    await setPetTarget(removed.id, false, home);
    let releaseTarget!: () => void, targetLocked!: () => void;
    const ready = new Promise<void>(resolve => { targetLocked = resolve; });
    const held = withPetTargetLock(home, async () => { targetLocked(); await new Promise<void>(resolve => { releaseTarget = resolve; }); });
    await ready;
    const operations = Promise.all([removeWorkspace(removed.id, home), setPetTarget(other.id, false, home)]);
    releaseTarget(); await held; await operations;
    assert.equal((await petState(home)).target?.project, other.id);
    assert.deepEqual(await registeredWorkspace(other.id, home), other);
    await registerWorkspace(removed.workspace, home);
    assert.equal((await petState(home)).target?.project, other.id);
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

test("worker preserves committed result contracts when independent settings reads fail", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-worker-commit-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  const entry = await registerFixture(home, "selected", workspace);
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  try {
    await setPetTarget(entry.id, false, home);
    await writeFile(join(home, "registry/unrelated.json"), "{");
    await writeFile(join(home, "pet/consumer.json"), "{");
    const updated = await worker.call("updateWorkspaceRoot", [join(root, "new-default")]);
    assert.deepEqual(updated, { config: await readGlobalConfig(home) });
    const removed = await worker.call("removeWorkspace", [entry.id]);
    assert.deepEqual(removed, { removed: entry });
    await assert.rejects(worker.call("workspaceSettings", []));
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    await registerWorkspace(workspace, home);
    await writeFile(join(home, "pet/target.json"), "{");
    await assert.rejects(worker.call("removeWorkspace", [entry.id]), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.equal((await registeredWorkspace(entry.id, home)).workspace, workspace);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
