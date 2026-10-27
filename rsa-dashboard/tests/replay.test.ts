import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, realpath, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getReplay } from "../lib/replay";
import { closeLogIndexes, getLogIndex, indexCacheStats } from "../lib/log-index";
import type { ReplayWindow, ReplayOverview, ReplayDetail } from "../lib/replay-types";
import type { FileMedia } from "../lib/file-response";

const start = Date.parse("2026-10-27T00:00:00Z");
const iso = (ms: number) => new Date(start + ms).toISOString();
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest();
function event(seq: number, ms: number, type: string, data: Record<string, unknown> = {}, trace: Record<string, string> = {}, epoch = "one") {
  return { seq, at: iso(ms), atMs: ms, type, data, trace: { epoch, ...trace } };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-replay-")));
  const workspace = join(root, "workspace"), run = join(workspace, "logs/run"), timeline = join(workspace, ".rsa/timeline");
  await mkdir(join(root, "project")); await mkdir(run, { recursive: true });
  await mkdir(join(timeline, "segments"), { recursive: true }); await mkdir(join(timeline, "objects"));
  await writeFile(join(root, "project/workspace.json"), JSON.stringify({ workspace }));
  await writeFile(join(run, "manifest.json"), JSON.stringify({ workspace, runId: "run", socket: "/no-host.sock" }));
  const events = [
    event(1, 0, "control", { mode: "auto" }),
    event(2, 1000, "action_start", { actionId: "a", controllerId: "pad.play" }, { traceId: "t", spanId: "s" }),
    event(3, 3000, "model_start", { model: "sol", observations: [] }, { modelCallId: "m" }),
    event(4, 4000, "tool_start", { toolName: "bash", intent: "prepare" }, { toolCallId: "c" }),
    event(5, 5000, "tool_end", { isError: true }, { toolCallId: "c" }),
    event(6, 8000, "model_end", {}, { modelCallId: "m" }),
    event(7, 12000, "action_end", { actionId: "a", status: "completed" }, { traceId: "t", spanId: "s" }),
    event(8, 20000, "control", { mode: "manual", reason: "budget" }),
    event(9, 30000, "control", { mode: "auto" }, {}, "two"),
    event(10, 32000, "control", { mode: "manual" }, {}, "two"),
  ];
  await writeFile(join(run, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  async function records(points: { ms: number; channel: string; runId?: string;
    video?: { asset: string; pts: number; gap?: boolean }[] }[], first = 1) {
    let offset = 0;
    const rows: Buffer[] = [], index = Buffer.alloc(points.length * 64);
    for (let n = 0; n < points.length; n++) {
      const sequence = first + n, id = `record-${sequence}`, { ms, channel } = points[n];
      const media = [0, 1].map(i => {
        const body = Buffer.from(`image:${sequence}:${i}`), asset = `objects/${hash(body).toString("hex")}.bin`;
        const video = points[n].video?.[i];
        if (video) return { mediaType: "image/png", timeline: { recordId: id, sequence, asset: video.asset,
          video: { pts: video.pts, timeBase: [1, 1000000], width: 400, height: 240,
            ...(video.gap ? { status: "gap", reason: "recording queue full" } : {}) } }, body };
        return { mediaType: "image/png", timeline: { recordId: id, sequence, asset }, body };
      });
      for (const m of media) if (!("video" in m.timeline)) await writeFile(join(timeline, m.timeline.asset), m.body);
      const row = Buffer.from(JSON.stringify({ id, sequence, recordedAt: iso(ms), capability: channel,
        runId: points[n].runId ?? "run", text: `sample ${sequence}`, media: media.map(({ body, ...m }) => m), data: { sample: sequence } }) + "\n");
      rows.push(row);
      index.writeDoubleBE((start + ms) / 1000, n * 64); index.writeBigUInt64BE(BigInt(sequence), n * 64 + 8);
      index.writeBigUInt64BE(BigInt(offset), n * 64 + 16); index.writeBigUInt64BE(BigInt(row.length), n * 64 + 24);
      hash(channel).copy(index, n * 64 + 32, 0, 16); hash(id).copy(index, n * 64 + 48, 0, 16); offset += row.length;
    }
    const stem = join(timeline, "segments", `segment-${first}`);
    await writeFile(stem + ".jsonl", Buffer.concat(rows)); await writeFile(stem + ".idx", index);
    await writeFile(stem + ".meta.json", JSON.stringify({ firstSequence: first, lastSequence: first + points.length - 1, count: points.length }));
  }
  await records([{ ms: 1000, channel: "vision" }, { ms: 2000, channel: "temperature" }, { ms: 5000, channel: "vision" },
    { ms: 9000, channel: "vision" }, { ms: 11000, channel: "vision" }, { ms: 14000, channel: "temperature" },
    { ms: 19000, channel: "vision" }, { ms: 25000, channel: "vision" }, { ms: 31000, channel: "vision" },
    { ms: 33000, channel: "vision", runId: "unrelated" }]);
  return { root, workspace, run, timeline, records,
    query: (query: Parameters<typeof getReplay>[2]) => getReplay("project", "run", query, root),
    close: async () => { await closeLogIndexes(); await rm(root, { recursive: true, force: true }); } };
}

test("replay uses all recorded channels, scopes epoch boundaries, and pairs spanning operations", async () => {
  const f = await fixture();
  try {
    const overview = await f.query({ mode: "overview", epoch: "one" }) as ReplayOverview;
    assert.deepEqual([overview.startAt, overview.endAt], [start, start + 20000]);
    assert.deepEqual(overview.capabilities.sort(), ["temperature", "vision"]);
    const window = await f.query({ mode: "window", epoch: "one", start: start + 10000, end: start + 15000 }) as ReplayWindow;
    assert.deepEqual(window.frames.map(frame => frame.sequence), [2, 4, 5, 6]);
    assert.equal(window.frames.find(frame => frame.sequence === 5)?.media.length, 2);
    const action = window.items.find(item => item.track === "action")!;
    assert.deepEqual([action.startAt, action.endAt, action.status], [start + 1000, start + 12000, "completed"]);
    assert.equal(window.items.filter(item => item.track === "model").length, 0);
    const full = await f.query({ mode: "window", epoch: "one", start, end: start + 40000 }) as ReplayWindow;
    assert(!full.frames.some(frame => frame.sequence >= 8));
    assert(full.items.some(item => item.track === "tool" && item.status === "error"));
    const second = await f.query({ mode: "window", epoch: "two", start: start + 30000, end: start + 32000 }) as ReplayWindow;
    assert.deepEqual(second.frames.map(frame => frame.sequence), [9]);
    const all = await f.query({ mode: "overview" }) as ReplayOverview;
    assert.equal(all.endAt, start + 32000);
    await assert.rejects(f.query({ mode: "overview", epoch: "fake" }), /没有时空轴记录/);
    await assert.rejects(f.query({ mode: "window", start, end: start + 60001 }), /不超过 60 秒/);
  } finally { await f.close(); }
});

test("video playback uses stable segment URLs, time offsets, explicit pending/gaps and scoped offline files", async () => {
  const f = await fixture();
  const assets = ["video/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.mp4", "video/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.mp4"];
  try {
    await mkdir(join(f.timeline, "video"));
    for (const asset of assets) {
      await writeFile(join(f.timeline, asset), "streaming video bytes");
      await writeFile(join(f.timeline, asset + ".json"), JSON.stringify({ status: "pending", durationSeconds: 0 }));
    }
    await f.records([
      { ms: 15000, channel: "dual", video: assets.map(asset => ({ asset, pts: 0 })) },
      { ms: 15500, channel: "dual", video: assets.map(asset => ({ asset, pts: 500000 })) },
      { ms: 15900, channel: "dual", video: assets.map(asset => ({ asset, pts: 900000, gap: true })) },
    ], 11);
    let page = await f.query({ mode: "window", epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    const first = page.frames.find(frame => frame.sequence === 11)!, second = page.frames.find(frame => frame.sequence === 12)!;
    assert.equal(first.media[0].video?.url, second.media[0].video?.url);
    assert.notEqual(first.media[0].video?.url, first.media[1].video?.url);
    assert.equal(first.media[0].video?.originAt, start + 15000);
    assert.equal(second.media[0].video?.originAt, start + 15000);
    assert.equal(first.media[0].video?.status, "pending");
    assert.equal(page.frames.find(frame => frame.sequence === 13)?.media[0].video?.status, "gap");
    await assert.rejects(f.query({ mode: "segment", epoch: "one", asset: assets[0] }), { status: 409 });
    for (const asset of assets) await writeFile(join(f.timeline, asset + ".json"), JSON.stringify({ status: "ready", durationSeconds: 0.6 }));
    page = await f.query({ mode: "window", epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    assert.equal(page.frames.find(frame => frame.sequence === 11)?.media[0].video?.status, "ready");
    const video = await f.query({ mode: "segment", epoch: "one", asset: assets[0] }) as FileMedia;
    assert.equal(video.file, join(f.timeline, assets[0])); assert.equal(video.mediaType, "video/mp4"); assert(!("bytes" in video));
    await assert.rejects(f.query({ mode: "segment", epoch: "two", asset: assets[0] }), { status: 404 });
    await assert.rejects(f.query({ mode: "segment", asset: "../video/escape.mp4" }), /无效/);
    await rm(join(f.timeline, assets[0])); await symlink(join(f.run, "events.jsonl"), join(f.timeline, assets[0]));
    await assert.rejects(f.query({ mode: "segment", asset: assets[0] }), /必须位于/);
  } finally { await f.close(); }
});

test("bounded pagination retains equal-time rows and is isolated from appended events", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 1100 }, (_, i) => JSON.stringify(event(i + 11, 16000, "diagnostic"))).join("\n") + "\n");
    const query = { mode: "window" as const, epoch: "one", start: start + 15000, end: start + 17000 };
    const first = await f.query(query) as ReplayWindow;
    assert.equal(first.frames.length + first.items.length, 500); assert(first.nextCursor);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(1111, 16500, "late")) + "\n");
    const ids = [...first.items.map(item => item.id), ...first.frames.map(item => item.id)];
    let cursor: string | undefined = first.nextCursor;
    while (cursor) {
      const page = await f.query({ ...query, cursor }) as ReplayWindow;
      assert(page.frames.length + page.items.length <= 500);
      ids.push(...page.items.map(item => item.id), ...page.frames.map(item => item.id)); cursor = page.nextCursor;
    }
    assert.equal(ids.length, 1102); assert.equal(new Set(ids).size, ids.length);
    await assert.rejects(f.query({ ...query, end: query.end + 1, cursor: first.nextCursor }), /分页游标/);
    const stats = indexCacheStats(); assert(stats.bytes <= stats.limit);
  } finally { await f.close(); }
});

test("record media and details are offline, scoped, canonical and do not copy source bytes", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.run, "events.jsonl"));
    const detail = await f.query({ mode: "detail", epoch: "one", record: "record-5", sequence: 5 }) as ReplayDetail;
    assert.deepEqual((detail.data as { data: unknown }).data, { sample: 5 });
    const image = await f.query({ mode: "media", epoch: "one", record: "record-5", sequence: 5, media: 1 }) as { bytes: Buffer };
    assert.equal(image.bytes.toString(), "image:5:1");
    await assert.rejects(f.query({ mode: "media", epoch: "one", record: "record-8", sequence: 8, media: 0 }), /不属于/);
    await assert.rejects(f.query({ mode: "detail", record: "wrong", sequence: 5 }), /不属于/);
    await assert.rejects(getReplay("../project", "run", { mode: "overview" }, f.root), /项目 ID/);
    const asset = join(f.timeline, "objects", hash("image:5:1").toString("hex") + ".bin");
    await rm(asset); await symlink(join(f.run, "events.jsonl"), asset);
    await assert.rejects(f.query({ mode: "media", record: "record-5", sequence: 5, media: 1 }), /必须位于/);
    assert.deepEqual(await readFile(join(f.run, "events.jsonl")), before);
  } finally { await f.close(); }
});

test("late finishes update existing spans; cancelled and unfinished actions remain explicit", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(11, 10000, "action_start", { actionId: "pending" }, { traceId: "t2", spanId: "s" })) + "\n");
    let page = await f.query({ mode: "window", epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    assert.equal(page.items.find(item => item.source.actionId === "pending")?.endAt, null);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(12, 18000, "action_end", { actionId: "pending", status: "interrupted" }, { traceId: "t2", spanId: "s" })) + "\n");
    page = await f.query({ mode: "window", epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    const span = page.items.find(item => item.source.actionId === "pending")!;
    assert.equal(span.endAt, start + 18000); assert.equal(span.status, "cancelled");
    const detail = await f.query({ mode: "detail", epoch: "one", id: span.id }) as ReplayDetail;
    assert.equal((detail.data as { events: unknown[] }).events.length, 2);
    await f.records([{ ms: 16000, channel: "vision" }], 11);
    page = await f.query({ mode: "window", epoch: "one", start: start + 15000, end: start + 17000 }) as ReplayWindow;
    assert(page.frames.some(frame => frame.sequence === 11));
    assert.equal(getLogIndex(f.run).meta("replay:sequence"), "11");
  } finally { await f.close(); }
});

test("model details use the recorded encoded input rather than the source frame, including older history", async () => {
  const f = await fixture();
  try {
    const encoded = Buffer.from("different resized model input"), asset = `objects/${hash(encoded).toString("hex")}.bin`;
    await writeFile(join(f.timeline, asset), encoded);
    const events = [
      event(11, 30100, "observation", { id: "old-image", mediaType: "image/png", timeline: {
        recordId: "record-1", sequence: 1, asset: `objects/${hash("image:1:0").toString("hex")}.bin` } }, {}, "two"),
      event(12, 30200, "observation_media", { observationId: "old-image", modelMedia: {
        asset, recordId: "record-1", sequence: 1, mediaType: "image/png", transform: "omp.resizeImage" } }, {}, "two"),
      event(13, 30300, "model_start", { model: "sol", observations: ["old-image"] }, { modelCallId: "history-model" }, "two"),
      event(14, 30400, "model_end", {}, { modelCallId: "history-model" }, "two"),
      // A later encode of the same observation is not the earlier request's input.
      event(15, 30500, "observation_media", { observationId: "old-image", modelMedia: {
        asset: `objects/${hash("image:1:0").toString("hex")}.bin`, recordId: "record-1", sequence: 1, mediaType: "image/png" } }, {}, "two"),
    ];
    await appendFile(join(f.run, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const detail = await f.query({ mode: "detail", epoch: "two", id: "event:13" }) as ReplayDetail;
    assert.equal(detail.observations?.[0].recordId, "record-1");
    const url = new URL(detail.observations![0].url!, "http://localhost");
    assert.equal(url.searchParams.get("id"), "model-media:12");
    const media = await f.query({ mode: "media", epoch: "two", id: "model-media:12" }) as { bytes: Buffer };
    assert.deepEqual(media.bytes, encoded);
    await assert.rejects(f.query({ mode: "media", epoch: "one", id: "model-media:12" }), /不属于/);
    assert.equal(getLogIndex(f.run).meta("run_projection"), undefined);
  } finally { await f.close(); }
});
