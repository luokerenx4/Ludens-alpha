import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCatalogCache, timelineRecord as readTimelineRecord } from "../lib/data";
import { awaitArchive } from "./fixtures/await-archive";
const timelineRecord = (...args: Parameters<typeof readTimelineRecord>) => awaitArchive(() => readTimelineRecord(...args));

const reference = { recordId: "temperature", sequence: 2 };
const details = { recordId: "temperature", sequence: 2, data: { temperature: 21.5 }, space: { frame: "room" } };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-record-")));
  const workspace = join(root, "workspace"), run = join(workspace, "logs/run");
  const timeline = join(workspace, ".rsa/timeline"), segments = join(timeline, "segments");
  await mkdir(join(root, "project"));
  await mkdir(run, { recursive: true });
  await mkdir(segments, { recursive: true });
  await writeFile(join(root, "project/workspace.json"), JSON.stringify({ workspace }));
  await writeFile(join(run, "manifest.json"), "{}");
  const snapshot = { id: reference.recordId, sequence: 2, timeline: reference, generation: null,
    recordedAt: "2026-10-27T00:00:00.000Z", sampling: { clock: "sensor", startedAtMs: 1, finishedAtMs: 2 } };
  const events = [
    { type: "perception_observe_end", data: { status: { state: "ready", generation: "worker" }, snapshot,
      records: [{ snapshot, text: "", observations: [] }],
      result: { id: "read", status: "completed", exitCode: 0, stdout: "", observations: [] } } },
    { type: "context", data: { observations: [], executions: ["read"] } },
    { type: "model_start", data: { observations: [] }, trace: { modelCallId: "model" } },
  ].map((event, index) => ({ ...event, seq: index + 1, at: new Date(index * 1000).toISOString(), atMs: index * 1000,
    trace: { epoch: "epoch", ...event.trace } }));
  await writeFile(join(run, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  return { root, workspace, run, timeline, segments };
}

test("record details read one indexed JSON payload, retain data/space and enforce the run reference", async () => {
  const f = await fixture();
  try {
    // The preceding bytes are deliberately invalid JSON: a full-segment parser would fail.
    const prefix = Buffer.from("unrelated prior payload\n");
    const payload = Buffer.from(JSON.stringify({ id: details.recordId, ...details, capability: "temperature", recordedAt: "2026-10-27T00:00:00.000Z", media: [] }) + "\n");
    const index = Buffer.alloc(128);
    index.writeDoubleBE(Date.parse("2026-10-27T00:00:00.000Z") / 1000, 64);
    createHash("sha256").update("temperature").digest().copy(index, 64 + 32, 0, 16);
    index.writeBigUInt64BE(2n, 64 + 8);
    index.writeBigUInt64BE(BigInt(prefix.length), 64 + 16);
    index.writeBigUInt64BE(BigInt(payload.length), 64 + 24);
    createHash("sha256").update(details.recordId).digest().copy(index, 64 + 48, 0, 16);
    await writeFile(join(f.segments, "segment.meta.json"), JSON.stringify({ firstSequence: 1, lastSequence: 2, count: 2 }));
    await writeFile(join(f.segments, "segment.idx"), index);
    await writeFile(join(f.segments, "segment.jsonl"), Buffer.concat([prefix, payload]));
    assert.deepEqual(await timelineRecord("project", "run", "temperature", 2, { call: "model" }, f.root), details);
    await assert.rejects(timelineRecord("project", "run", "temperature", 2, { call: "other-model" }, f.root), /没有引用指定观测/);
    await assert.rejects(timelineRecord("project", "run", "temperature", 0, { call: "model" }, f.root), /无效的时空轴记录引用/);
    await assert.rejects(timelineRecord("project", "run", "other-record", 2, { call: "model" }, f.root), /没有引用指定观测/);

    await writeFile(join(f.root, "outside.jsonl"), Buffer.concat([prefix, payload]));
    await rm(join(f.segments, "segment.jsonl"));
    await symlink(join(f.root, "outside.jsonl"), join(f.segments, "segment.jsonl"));
    await assert.rejects(timelineRecord("project", "run", "temperature", 2, { call: "model" }, f.root), /必须位于当前工作区时空轴内/);
  } finally { clearCatalogCache(); await rm(f.root, { recursive: true, force: true }); }
});

test("missing retained records return expiry without inventing data from the log", async () => {
  const f = await fixture();
  try {
    await assert.rejects(timelineRecord("project", "run", "temperature", 2, { call: "model" }, f.root), {
      status: 410, code: "OBSERVATION_EXPIRED",
    });
  } finally { clearCatalogCache(); await rm(f.root, { recursive: true, force: true }); }
});

test("window-only records query the matched current host once, never restart or sample", async () => {
  const f = await fixture();
  const socket = join(f.root, "host.sock");
  const requests: Record<string, unknown>[] = [];
  let currentRun = "run";
  const server = createServer(client => {
    let input = "";
    client.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      requests.push(request);
      const value = request.kind === "status" ? { runId: currentRun }
        : { records: [{ id: details.recordId, sequence: 2, data: details.data, space: details.space }] };
      client.end(JSON.stringify({ ok: true, value }) + "\n");
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    await writeFile(join(f.run, "manifest.json"), JSON.stringify({ runId: "run", workspace: f.workspace, socket }));
    assert.deepEqual(await timelineRecord("project", "run", "temperature", 2, { call: "model" }, f.root), details);
    assert.deepEqual(requests, [{ kind: "status", argv: [] }, { kind: "perception", argv: ["observe"], query: { id: "temperature" } }]);
    currentRun = "unrelated";
    requests.length = 0;
    await assert.rejects(timelineRecord("project", "run", "temperature", 2, { call: "model" }, f.root), { status: 410 });
    assert.deepEqual(requests, [{ kind: "status", argv: [] }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    clearCatalogCache(); await rm(f.root, { recursive: true, force: true });
  }
});
