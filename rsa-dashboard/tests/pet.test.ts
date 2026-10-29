import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { petState, recordPetConsumer, setPetTarget, PET_HEARTBEAT_TTL_MS } from "../lib/pet-state";
import { petStatus, petStatusKey, type PetState } from "../lib/pet";
import { catalog } from "../lib/data";
import { registerFixture } from "./fixtures/registry";
import { withPetTargetLock, withWorkspaceRegistrationLock } from "../../shared/ludens";
import { DashboardWorker } from "../lib/dashboard-worker";

const consumerInput = () => ({
  instanceId: "desktop", pid: process.pid, revision: null, workspace: null,
  runId: null, phase: "idle", error: null,
});

test("Pet follows registered workspaces without a device; choice persists without polluting the catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-target-")));
  try {
    const workspace = join(root, "work");
    await mkdir(workspace);
    await registerFixture(root, "registered", workspace);
    assert.deepEqual(await petState(root), { target: null, targetConfigured: false, consumer: null, connected: false });
    assert.equal((await readdir(root)).includes("pet"), false, "an empty read does not create pet state or lock directories");
    await assert.rejects(setPetTarget(workspace, false, root), /未找到/);
    await assert.rejects(setPetTarget("../registered", false, root), /未找到/);
    const first = await setPetTarget("registered", false, root);
    assert.equal(first.target?.workspace, workspace);
    assert.deepEqual(Object.keys(first), ["target"]);
    assert.deepEqual(await petState(root), { ...first, targetConfigured: true, consumer: null, connected: false });
    assert.equal((await setPetTarget("registered", false, root)).target?.revision, first.target?.revision);
    assert.deepEqual((await catalog(root, true)).map((project) => project.id), ["registered"]);
    await setPetTarget(null, false, root);
    assert.equal((await petState(root)).targetConfigured, true, "an explicit stop is a saved choice");
    assert.equal((await setPetTarget("registered", true, root)).target, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary pet polling does not need writable target state", { skip: process.getuid?.() === 0 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-read-only-")));
  const pet = join(root, "pet");
  try {
    await registerFixture(root, "selected", join(root, "workspace"));
    const selected = await setPetTarget("selected", false, root);
    await chmod(pet, 0o500);
    assert.deepEqual(await petState(root), { ...selected, targetConfigured: true, consumer: null, connected: false });
    assert.deepEqual(await readdir(pet), ["target.json"], "polling leaves no lock or temporary files");
  } finally { await chmod(pet, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("Pet heartbeat reports connection independently from target application and expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-heartbeat-"));
  try {
    const receipt = await recordPetConsumer(consumerInput(), root);
    assert.deepEqual(Object.keys(receipt), ["consumer"]);
    const state = await petState(root);
    assert.deepEqual(state.consumer, receipt.consumer);
    assert.equal(state.connected, true);
    assert.equal(petStatus(state), "已停止跟随");
    const selected = {
      ...state,
      target: { project: "selected", workspace: "/workspace", revision: "new", updatedAt: new Date().toISOString() },
    };
    assert.equal(petStatus(selected), "等待应用选择");
    assert.equal(petStatus({ ...selected, consumer: { ...state.consumer!, phase: "error", error: "old workspace offline" } }), "等待应用选择");
    assert.equal(petStatus({ ...selected, consumer: {
      ...state.consumer!, workspace: "/workspace", targetRevision: "new", phase: "error", error: "Cannot open workspace",
    } }), "跟随遇到问题");
    assert.equal((await petState(root, Date.parse(state.consumer!.seenAt) + PET_HEARTBEAT_TTL_MS)).connected, false);
    await assert.rejects(recordPetConsumer({ phase: "following" }, root), /无效/);
    await assert.rejects(recordPetConsumer({ ...state.consumer, pid: 0 }, root), /无效/);
    const exited = spawn(process.execPath, ["-e", ""]);
    await once(exited, "close");
    await recordPetConsumer({ ...state.consumer, pid: exited.pid }, root);
    assert.equal((await petState(root)).connected, false); // Fresh heartbeat cannot keep a closed desktop alive.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("follow status requires evidence for the selected revision and distinguishes attempted from loaded", () => {
  const state: PetState = { connected: true, targetConfigured: true,
    target: { project: "selected", workspace: "/workspace", revision: "new", updatedAt: "2026-10-30T00:00:00Z" },
    consumer: { ...consumerInput(), phase: "error", workspace: "/workspace", error: "Cannot open workspace",
      revision: "old", seenAt: "2026-10-30T00:00:00Z" },
  };
  assert.equal(petStatusKey(state), "switching", "a same-path old loaded error is not this target's error");
  assert.equal(petStatusKey({ ...state, consumer: { ...state.consumer!, targetRevision: "old" } }), "switching");
  assert.equal(petStatusKey({ ...state, consumer: { ...state.consumer!, revision: null, targetRevision: "new" } }), "followError",
    "source creation can fail before any revision has loaded");
  assert.equal(petStatusKey({ ...state, consumer: { ...state.consumer!, revision: "new" } }), "followError");
  assert.equal(petStatusKey({ ...state, consumer: { ...state.consumer!, revision: "new", targetRevision: "other" } }), "switching",
    "explicit attempted revision is authoritative for an error");
  assert.equal(petStatusKey({ ...state, consumer: { ...state.consumer!, targetRevision: "new", workspace: "/other" } }), "switching");
  const loaded = { ...state.consumer!, phase: "following" as const, error: null, revision: "new", targetRevision: "new" };
  assert.equal(petStatusKey({ ...state, consumer: loaded }), "waitingRun");
  assert.equal(petStatusKey({ ...state, consumer: { ...loaded, runId: "run" } }), "following");
  assert.equal(petStatusKey({ ...state, consumer: { ...loaded, phase: "switching" } }), "switching");
  assert.equal(petStatusKey({ ...state, consumer: { ...loaded, targetRevision: "other" } }), "switching");
  assert.equal(petStatusKey({ ...state, targetUnavailable: true }), "unavailable");
  assert.equal(petStatusKey({ ...state, connected: false }), "disconnected");
  assert.equal(petStatusKey({ ...state, connected: null, consumer: null, consumerError: "Unreadable" }), "unknown");
  assert.equal(petStatusKey(null), "connecting");
});

test("target receipts commit independently of corrupt consumer state and GET preserves the known target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-committed-")));
  try {
    await registerFixture(root, "first", join(root, "first"));
    await registerFixture(root, "second", join(root, "second"));
    await setPetTarget("first", false, root);
    await writeFile(join(root, "pet/consumer.json"), "{");
    const saved = await setPetTarget("second", false, root);
    assert.equal(saved.target?.project, "second");
    assert.deepEqual(saved, { target: JSON.parse(await readFile(join(root, "pet/target.json"), "utf8")) });
    const partial = await petState(root);
    assert.deepEqual(partial.target, saved.target);
    assert.equal(partial.consumer, null);
    assert.equal(partial.connected, null);
    assert.ok(partial.consumerError);
    assert.deepEqual(await setPetTarget("second", false, root), saved, "unchanged receipt retains its revision");
    assert.deepEqual(await setPetTarget(null, false, root), { target: null });
    assert.equal(JSON.parse(await readFile(join(root, "pet/target.json"), "utf8")), null);
    assert.equal((await petState(root)).connected, null, "stopping does not invent a disconnected consumer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ifUnset receipts describe the actual locked choice, including explicit stop and an offline selection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-if-unset-")));
  try {
    await registerFixture(root, "first", join(root, "first"));
    await registerFixture(root, "second", join(root, "second"));
    const first = await setPetTarget("first", true, root);
    assert.deepEqual(await setPetTarget("second", true, root), first);
    await rm(join(root, "first"), { recursive: true });
    assert.deepEqual(await setPetTarget("second", true, root), first, "startup must not replace a retained offline choice");
    const offline = await petState(root);
    assert.deepEqual(offline.target, first.target, "an unavailable selection is still saved");
    assert.equal(offline.targetUnavailable, true);
    await setPetTarget(null, false, root);
    assert.deepEqual(await setPetTarget("second", true, root), { target: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent selections return their own committed receipts rather than a later observation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-receipts-race-")));
  try {
    await registerFixture(root, "first", join(root, "first"));
    await registerFixture(root, "second", join(root, "second"));
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const held = withPetTargetLock(root, async () => { locked(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const first = setPetTarget("first", false, root), second = setPetTarget("second", false, root);
    release(); await held;
    const receipts = await Promise.all([first, second]);
    assert.equal(receipts[0].target?.project, "first");
    assert.equal(receipts[1].target?.project, "second");
    assert.notEqual(receipts[0].target?.revision, receipts[1].target?.revision);
    const stored = JSON.parse(await readFile(join(root, "pet/target.json"), "utf8"));
    assert.equal(stored.revision, receipts[1].target?.revision, "the last accepted write wins in admission order");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed or unreadable heartbeat data is unknown, while a missing heartbeat is disconnected", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-consumer-read-")));
  try {
    await registerFixture(root, "selected", join(root, "workspace"));
    const selected = await setPetTarget("selected", false, root);
    const valid = { ...consumerInput(), seenAt: new Date().toISOString() };
    for (const invalid of [null, {}, { ...valid, pid: 0 }, { ...valid, phase: "bogus" },
      { ...valid, seenAt: "invalid" }, { ...valid, targetRevision: 42 }]) {
      await writeFile(join(root, "pet/consumer.json"), JSON.stringify(invalid));
      const state = await petState(root);
      assert.deepEqual(state.target, selected.target);
      assert.equal(state.connected, null);
      assert.equal(state.consumer, null);
      assert.ok(state.consumerError);
    }
    await rm(join(root, "pet/consumer.json"));
    await mkdir(join(root, "pet/consumer.json"));
    assert.equal((await petState(root)).connected, null, "I/O errors are not disconnection evidence");
    await rm(join(root, "pet/consumer.json"), { recursive: true });
    assert.deepEqual(await petState(root), { ...selected, targetConfigured: true, consumer: null, connected: false });
    const receipt = await recordPetConsumer({ ...consumerInput(), targetRevision: null }, root);
    assert.equal((await petState(root)).connected, true);
    assert.deepEqual((await petState(root)).consumer, receipt.consumer);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("consumer receipt is independent of target reads and validates attempted selection metadata", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-consumer-receipt-")));
  try {
    await mkdir(join(root, "pet"));
    await writeFile(join(root, "pet/target.json"), "{");
    const receipt = await recordPetConsumer({ ...consumerInput(), phase: "error", error: "source failed",
      workspace: "/workspace", targetRevision: "attempted-revision" }, root);
    assert.equal(receipt.consumer.targetRevision, "attempted-revision");
    assert.equal(receipt.consumer.revision, null, "attempting a selection is not proof the source loaded");
    assert.deepEqual(receipt.consumer, JSON.parse(await readFile(join(root, "pet/consumer.json"), "utf8")));
    await assert.rejects(petState(root), SyntaxError, "target failures remain genuine independent read errors");
    await assert.rejects(recordPetConsumer({ ...consumerInput(), targetRevision: 42 }, root), /无效/);
    assert.deepEqual(JSON.parse(await readFile(join(root, "pet/consumer.json"), "utf8")), receipt.consumer,
      "invalid input cannot overwrite the last confirmed heartbeat");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline, replaced and unregistered directories retain the saved choice without making it consumable", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-target-unavailable-")));
  try {
    const workspace = join(root, "workspace"), moved = join(root, "offline");
    await registerFixture(root, "selected", workspace);
    const selected = await setPetTarget("selected", false, root);
    const targetPath = join(root, "pet/target.json"), saved = await readFile(targetPath, "utf8");
    const unavailable = async () => {
      const state = await petState(root);
      assert.deepEqual(state.target, selected.target);
      assert.equal(state.targetConfigured, true);
      assert.equal(state.targetUnavailable, true);
      assert.equal(await readFile(targetPath, "utf8"), saved, "availability checks never erase the saved choice");
    };
    await rename(workspace, moved); await unavailable();
    await rename(moved, workspace);
    assert.equal((await petState(root)).targetUnavailable, undefined, "the same registered directory can recover");
    await writeFile(join(workspace, ".rsa/workspace.json"), JSON.stringify({ version: 1, id: "replacement" }));
    await unavailable();
    await writeFile(join(workspace, ".rsa/workspace.json"), JSON.stringify({ version: 1, id: "selected" }));
    await rm(join(root, "registry/selected.json"));
    await unavailable();
    await assert.rejects(setPetTarget("selected", false, root), /未找到/);
    assert.equal(await readFile(targetPath, "utf8"), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid saved target shapes remain read failures rather than being presented as no selection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-invalid-target-")));
  try {
    await registerFixture(root, "selected", join(root, "workspace"));
    const saved = await setPetTarget("selected", false, root);
    for (const value of [{}, [], false, { ...saved.target, workspace: "relative" },
      { ...saved.target, revision: "" }, { ...saved.target, updatedAt: "invalid" }]) {
      await writeFile(join(root, "pet/target.json"), JSON.stringify(value));
      await assert.rejects(petState(root), /无效的 Ludens Pet 跟随目标/);
      await assert.rejects(setPetTarget("selected", true, root), /无效的 Ludens Pet 跟随目标/);
      assert.deepEqual(JSON.parse(await readFile(join(root, "pet/target.json"), "utf8")), value);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker keeps committed receipts separate from independent state failures", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-worker-receipt-")));
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: root } });
  try {
    await registerFixture(root, "selected", join(root, "workspace"));
    await mkdir(join(root, "pet"));
    await writeFile(join(root, "pet/consumer.json"), "{");
    const receipt = await worker.call("petTarget", ["selected", false]);
    assert.deepEqual(receipt, { target: JSON.parse(await readFile(join(root, "pet/target.json"), "utf8")) });
    const partial = await worker.call("petState", []);
    assert.deepEqual(partial.target, receipt.target);
    assert.equal(partial.connected, null);
    assert.ok(partial.consumerError);
    await writeFile(join(root, "pet/target.json"), "{");
    const recorded = await worker.call("petConsumer", [consumerInput()]);
    assert.deepEqual(recorded, { consumer: JSON.parse(await readFile(join(root, "pet/consumer.json"), "utf8")) });
    await assert.rejects(worker.call("petState", []));
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ["committed", "rejected"] as const) test(`a verifying worker GET waits for an admitted write after its response is lost (${outcome})`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-worker-unconfirmed-")));
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: root } });
  let release: (() => void) | undefined, held: Promise<void> | undefined;
  const controller = new AbortController();
  try {
    await registerFixture(root, "selected", join(root, "workspace"));
    await setPetTarget(null, false, root);
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    held = withWorkspaceRegistrationLock(root, "selected", async () => { locked(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const pending = worker.call("petTarget", ["selected", false], controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    // Worker messages enter in order. A later independent heartbeat proves the
    // target handler was admitted, even though its registration lock is held.
    await worker.call("petConsumer", [consumerInput()]);
    controller.abort(); await rejected;
    let observed = false;
    const verifying = worker.call("petState", []).then(value => { observed = true; return value; });
    const heartbeat = await worker.call("petConsumer", [consumerInput()]);
    assert.equal(heartbeat.consumer.phase, "idle", "consumer receipts do not wait for target writes");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(observed, false, "GET must not clear write uncertainty with the previous saved value");
    assert.equal(JSON.parse(await readFile(join(root, "pet/target.json"), "utf8")), null);
    if (outcome === "rejected") await rm(join(root, "registry/selected.json"));
    release!(); await held;
    const state = await verifying;
    assert.equal(state.target?.project ?? null, outcome === "committed" ? "selected" : null);
    assert.equal(state.targetConfigured, true);
    assert.equal(state.connected, true, "heartbeat age is measured after the read barrier");
    if (outcome === "rejected") {
      await registerFixture(root, "selected", join(root, "workspace"));
      assert.equal((await worker.call("petTarget", ["selected", false])).target?.project, "selected");
      assert.equal((await worker.call("petState", [])).target?.project, "selected", "failed writes do not poison later reads or writes");
    }
  } finally { controller.abort(); release?.(); await held; await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("target admission and read barriers are isolated by home", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pet-queue-homes-")));
  const first = join(directory, "first"), second = join(directory, "second");
  let release!: () => void;
  let held: Promise<void> | undefined, writing: Promise<unknown> | undefined;
  try {
    await registerFixture(first, "first", join(directory, "first-workspace"));
    await registerFixture(second, "second", join(directory, "second-workspace"));
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    held = withPetTargetLock(first, async () => { locked(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    writing = setPetTarget("first", false, first);
    let firstReadFinished = false;
    const reading = petState(first).then(value => { firstReadFinished = true; return value; });
    const independent = await setPetTarget("second", false, second);
    assert.equal((await petState(second)).target?.revision, independent.target?.revision);
    assert.equal(firstReadFinished, false);
    release(); await held; await writing;
    assert.equal((await reading).target?.project, "first");
  } finally { release?.(); await held; await writing; await rm(directory, { recursive: true, force: true }); }
});
