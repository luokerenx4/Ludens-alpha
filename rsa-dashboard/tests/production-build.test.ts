import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuild, stampBuild } from "../scripts/production.mjs";

test("permanent Dashboard refuses missing, stale and replaced production builds", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-build-")), root = join(parent, "dashboard");
  try {
    await mkdir(join(root, ".next"), { recursive: true });
    await mkdir(join(root, "worker"));
    await mkdir(join(root, "messages"));
    await writeFile(join(root, "worker/worker.ts"), "first version");
    await writeFile(join(root, "messages/en.json"), JSON.stringify({ title: "Console" }));
    await assert.rejects(checkBuild(root), /missing or stale/);
    await writeFile(join(root, ".next/BUILD_ID"), "built-one");
    await stampBuild(root); await checkBuild(root);
    await writeFile(join(root, "worker/worker.ts"), "new backend version");
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root); await checkBuild(root);
    await writeFile(join(root, "messages/en.json"), JSON.stringify({ title: "Ludens Console" }));
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root); await checkBuild(root);
    await writeFile(join(root, ".next/BUILD_ID"), "another build");
    await assert.rejects(checkBuild(root), /missing or stale/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
