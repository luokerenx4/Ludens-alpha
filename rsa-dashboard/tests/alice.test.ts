import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { aliceState, recordAliceConsumer, setAliceTarget, ALICE_HEARTBEAT_TTL_MS } from "../lib/alice-state";
import { aliceStatus } from "../lib/alice";
import { catalog } from "../lib/data";

test("Alice follows registered workspaces without a device; choice persists without polluting the catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alice-target-")));
  try {
    const workspace = join(root, "work");
    await mkdir(workspace);
    await mkdir(join(root, "registered"));
    await writeFile(join(root, "registered/workspace.json"), JSON.stringify({ workspace }));
    assert.deepEqual(aliceState(root), { target: null, consumer: null, connected: false });
    await assert.rejects(setAliceTarget(workspace, false, root), /未找到/);
    await assert.rejects(setAliceTarget("../registered", false, root), /未找到/);
    const first = await setAliceTarget("registered", false, root);
    assert.equal(first.target?.workspace, workspace);
    assert.equal(first.connected, false);
    assert.deepEqual(aliceState(root), first);
    assert.equal((await setAliceTarget("registered", false, root)).target?.revision, first.target?.revision);
    assert.deepEqual((await catalog(root, true)).map((project) => project.id).sort(), ["registered", "work"]);
    await setAliceTarget(null, false, root);
    assert.equal((await setAliceTarget("registered", true, root)).target, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Alice heartbeat reports connection independently from target application and expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "alice-heartbeat-"));
  try {
    const state = recordAliceConsumer({
      instanceId: "desktop", pid: process.pid, revision: null, workspace: null,
      runId: null, phase: "idle", error: null,
    }, root);
    assert.equal(state.connected, true);
    assert.equal(aliceStatus(state), "已停止跟随");
    const selected = {
      ...state,
      target: { project: "selected", workspace: "/workspace", revision: "new", updatedAt: new Date().toISOString() },
    };
    assert.equal(aliceStatus(selected), "正在切换…");
    assert.equal(aliceStatus({ ...selected, consumer: { ...state.consumer!, phase: "error", error: "old workspace offline" } }), "正在切换…");
    assert.equal(aliceStatus({ ...selected, consumer: {
      ...state.consumer!, workspace: "/workspace", phase: "error", error: "Cannot open workspace",
    } }), "跟随遇到问题");
    assert.equal(aliceState(root, Date.parse(state.consumer!.seenAt) + ALICE_HEARTBEAT_TTL_MS).connected, false);
    assert.throws(() => recordAliceConsumer({ phase: "following" }, root), /无效/);
    assert.throws(() => recordAliceConsumer({ ...state.consumer, pid: 0 }, root), /无效/);
    const exited = spawn(process.execPath, ["-e", ""]);
    await once(exited, "close");
    const disconnected = recordAliceConsumer({ ...state.consumer, pid: exited.pid }, root);
    assert.equal(disconnected.connected, false); // Fresh heartbeat cannot keep a closed desktop alive.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
