import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { petState, recordPetConsumer, setPetTarget, PET_HEARTBEAT_TTL_MS } from "../lib/pet-state";
import { petStatus } from "../lib/pet";
import { catalog } from "../lib/data";
import { registerFixture } from "./fixtures/registry";

test("Pet follows registered workspaces without a device; choice persists without polluting the catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-target-")));
  try {
    const workspace = join(root, "work");
    await mkdir(workspace);
    await registerFixture(root, "registered", workspace);
    assert.deepEqual(await petState(root), { target: null, consumer: null, connected: false });
    await assert.rejects(setPetTarget(workspace, false, root), /未找到/);
    await assert.rejects(setPetTarget("../registered", false, root), /未找到/);
    const first = await setPetTarget("registered", false, root);
    assert.equal(first.target?.workspace, workspace);
    assert.equal(first.connected, false);
    assert.deepEqual(await petState(root), first);
    assert.equal((await setPetTarget("registered", false, root)).target?.revision, first.target?.revision);
    assert.deepEqual((await catalog(root, true)).map((project) => project.id), ["registered"]);
    await setPetTarget(null, false, root);
    assert.equal((await setPetTarget("registered", true, root)).target, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pet heartbeat reports connection independently from target application and expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-heartbeat-"));
  try {
    const state = await recordPetConsumer({
      instanceId: "desktop", pid: process.pid, revision: null, workspace: null,
      runId: null, phase: "idle", error: null,
    }, root);
    assert.equal(state.connected, true);
    assert.equal(petStatus(state), "已停止跟随");
    const selected = {
      ...state,
      target: { project: "selected", workspace: "/workspace", revision: "new", updatedAt: new Date().toISOString() },
    };
    assert.equal(petStatus(selected), "正在切换…");
    assert.equal(petStatus({ ...selected, consumer: { ...state.consumer!, phase: "error", error: "old workspace offline" } }), "正在切换…");
    assert.equal(petStatus({ ...selected, consumer: {
      ...state.consumer!, workspace: "/workspace", phase: "error", error: "Cannot open workspace",
    } }), "跟随遇到问题");
    assert.equal((await petState(root, Date.parse(state.consumer!.seenAt) + PET_HEARTBEAT_TTL_MS)).connected, false);
    await assert.rejects(recordPetConsumer({ phase: "following" }, root), /无效/);
    await assert.rejects(recordPetConsumer({ ...state.consumer, pid: 0 }, root), /无效/);
    const exited = spawn(process.execPath, ["-e", ""]);
    await once(exited, "close");
    const disconnected = await recordPetConsumer({ ...state.consumer, pid: exited.pid }, root);
    assert.equal(disconnected.connected, false); // Fresh heartbeat cannot keep a closed desktop alive.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
