import { registerFixture } from "./fixtures/registry";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitArchive } from "./fixtures/await-archive";

test("getActivity keeps snapshots and cursor deltas readable while a published generation is frozen", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-activity-frozen-")));
  const previousRoot = process.env.LUDENS_HOME;
  process.env.LUDENS_HOME = root;
  // getActivity resolves the same registry and retained index as the HTTP worker.
  const { getActivity, refreshActivity } = await import("../lib/activity");
  const { getLogIndex, closeLogIndexes } = await import("../lib/log-index");
  const { closeArchiveBuilds } = await import("../lib/cold-build");
  const workspace = join(root, "workspace"), path = join(workspace, "logs", "run");
  const event = (seq: number, type: string, data: Record<string, unknown>) => ({
    seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
    type, data, trace: { epoch: "cycle" },
  });
  try {
    await mkdir(path, { recursive: true });
    await registerFixture(root, "fixture", workspace);
    await writeFile(join(path, "manifest.json"), JSON.stringify({ kind: "benchmark", model: "fixture", drivers: [] }));
    await writeFile(join(path, "events.jsonl"), [event(1, "control", { mode: "auto" }),
      event(2, "tool_start", { toolName: "read", intent: "first intent" })].map(row => JSON.stringify(row)).join("\n") + "\n");
    const first = await awaitArchive(() => getActivity("fixture", "run"));
    assert.equal(first.mode, "snapshot");
    assert.ok("cursor" in first && first.cursor);
    const cursor = first.cursor!;
    const index = getLogIndex(path);
    assert.equal(index.meta("cold:ready"), "1");

    await appendFile(join(path, "events.jsonl"), JSON.stringify(event(3, "tool_start", {
      toolName: "read", intent: "second intent",
    })) + "\n");
    await refreshActivity(index);
    await index.freeze();
    const checkpoint = await readFile(join(index.directory, "checkpoint.json"), "utf8");
    await assert.rejects(index.exclusive(async () => {}), { status: 202, code: "ARCHIVE_PREPARING" });

    const snapshot = await getActivity("fixture", "run");
    assert.equal(snapshot.mode, "snapshot");
    assert.equal(snapshot.scope.epoch, "cycle");
    assert.equal(snapshot.current.intent, "second intent");
    const delta = await getActivity("fixture", "run", undefined, { cursor });
    assert.equal(delta.mode, "delta");
    assert.equal(delta.scope.epoch, snapshot.scope.epoch);
    assert.equal(delta.current.intent, snapshot.current.intent);
    assert.ok(delta.blocks.length > 0, "the pre-freeze cursor still receives its unread changes");
    assert.ok("cursor" in delta && delta.cursor);
    const caughtUp = await getActivity("fixture", "run", undefined, { cursor: delta.cursor! });
    assert.equal(caughtUp.mode, "delta");
    assert.deepEqual(caughtUp.blocks, []);
    assert.equal(index.frozen, true);
    assert.equal(await readFile(join(index.directory, "checkpoint.json"), "utf8"), checkpoint);
  } finally {
    await closeArchiveBuilds();
    await closeLogIndexes();
    if (previousRoot === undefined) delete process.env.LUDENS_HOME;
    else process.env.LUDENS_HOME = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
