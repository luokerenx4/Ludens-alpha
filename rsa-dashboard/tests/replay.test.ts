import { registerFixture } from "./fixtures/registry";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, realpath, rm, symlink, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getReplay } from "../lib/replay";
import { closeLogIndexes, getLogIndex, indexCacheStats, resetStorageMetrics, storageMetrics } from "../lib/log-index";
import type { ReplayWindow, ReplayOverview, ReplayDetail, ReplaySearchResult } from "../lib/replay-types";
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
  await mkdir(run, { recursive: true });
  await mkdir(join(timeline, "segments"), { recursive: true }); await mkdir(join(timeline, "objects"));
  await registerFixture(root, "project", workspace);
  await writeFile(join(run, "manifest.json"), JSON.stringify({ workspace, workspaceId: "project", runId: "run", socket: "/no-host.sock" }));
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
    window: async (query: Omit<Parameters<typeof getReplay>[2], "mode">) => {
      await getReplay("project", "run", { mode: "overview", epoch: query.epoch }, root);
      const frames = await getReplay("project", "run", { ...query, mode: "frames" }, root) as ReplayWindow;
      const events = await getReplay("project", "run", { ...query, mode: "events" }, root) as ReplayWindow;
      return { ...frames, items: events.items };
    },
    close: async () => { await closeLogIndexes(); await rm(root, { recursive: true, force: true }); } };
}

test("replay uses all recorded channels, scopes epoch boundaries, and pairs spanning operations", async () => {
  const f = await fixture();
  try {
    const overview = await f.query({ mode: "overview", epoch: "one" }) as ReplayOverview;
    assert.deepEqual([overview.startAt, overview.endAt], [start, start + 20000]);
    assert.equal(overview.coverage?.complete, true);
    const window = await f.window({ epoch: "one", start: start + 10000, end: start + 15000 }) as ReplayWindow;
    assert.deepEqual(window.frames.map(frame => frame.sequence), [2, 4, 5, 6]);
    assert.equal(window.frames.find(frame => frame.sequence === 5)?.media.length, 2);
    const action = window.items.find(item => item.track === "action")!;
    assert.deepEqual([action.startAt, action.endAt, action.status], [start + 1000, start + 12000, "completed"]);
    assert.equal(window.items.filter(item => item.track === "model").length, 0);
    const full = await f.window({ epoch: "one", start, end: start + 40000 }) as ReplayWindow;
    assert(!full.frames.some(frame => frame.sequence >= 8));
    assert(full.items.some(item => item.track === "tool" && item.status === "error"));
    const second = await f.window({ epoch: "two", start: start + 30000, end: start + 32000 }) as ReplayWindow;
    assert.deepEqual(second.frames.map(frame => frame.sequence), [9]);
    const all = await f.query({ mode: "overview" }) as ReplayOverview;
    assert.equal(all.endAt, start + 32000);
    await assert.rejects(f.query({ mode: "overview", epoch: "fake" }), /没有时空轴记录/);
    await assert.rejects(f.window({ start, end: start + 60001 }), /不超过 60 秒/);
  } finally { await f.close(); }
});

test("replay exposes control cycles and resolves latest without building run statistics", async () => {
  const f = await fixture();
  try {
    const latest = await f.query({ mode: "overview", epoch: "latest" }) as ReplayOverview;
    assert.deepEqual(latest.cycles, [{ epoch: "one", startedAt: iso(0) }, { epoch: "two", startedAt: iso(30000) }]);
    assert.equal(latest.epoch, "two");
    assert.deepEqual([latest.startAt, latest.endAt], [start + 30000, start + 32000]);
    const all = await f.query({ mode: "overview", epoch: "all" }) as ReplayOverview;
    assert.equal(all.epoch, null);
    assert.deepEqual([all.startAt, all.endAt], [start, start + 32000]);
    const earlier = await f.query({ mode: "overview", epoch: "one" }) as ReplayOverview;
    assert.equal(earlier.epoch, "one");
    const frames = await f.query({ mode: "frames", epoch: latest.epoch!, start: latest.startAt, end: latest.endAt }) as ReplayWindow;
    assert.ok(frames.frames.length);
    assert.ok(frames.frames.flatMap(frame => frame.media).every(media => new URL(media.url, "http://localhost").searchParams.get("epoch") === "two"));
    const directories = await readdir(getLogIndex(f.run).directory);
    assert.equal(directories.some(name => name.startsWith("run-")), false, "cycle selection only reads canonical control metadata");
  } finally { await f.close(); }
});

test("video playback has stable asset identity, recorded proof URLs, explicit gaps and scoped offline files", async () => {
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
    let page = await f.window({ epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    const first = page.frames.find(frame => frame.sequence === 11)!, second = page.frames.find(frame => frame.sequence === 12)!;
    assert.equal(first.media[0].video?.assetId, second.media[0].video?.assetId);
    assert.notEqual(first.media[0].video?.url, second.media[0].video?.url);
    assert.notEqual(first.media[0].video?.url, first.media[1].video?.url);
    assert.equal(first.media[0].video?.originAt, start + 15000);
    assert.equal(second.media[0].video?.originAt, start + 15000);
    assert.equal(first.media[0].video?.status, "pending");
    assert.equal(page.frames.find(frame => frame.sequence === 13)?.media[0].video?.status, "gap");
    await assert.rejects(f.query({ mode: "segment", epoch: "one", record: "record-11", sequence: 11, media: 0, asset: assets[0] }), { status: 409 });
    for (const asset of assets) await writeFile(join(f.timeline, asset + ".json"), JSON.stringify({ status: "ready", durationSeconds: 0.6 }));
    page = await f.window({ epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    assert.equal(page.frames.find(frame => frame.sequence === 11)?.media[0].video?.status, "ready");
    const video = await f.query({ mode: "segment", epoch: "one", record: "record-11", sequence: 11, media: 0, asset: assets[0] }) as FileMedia;
    assert.equal(video.file, join(f.timeline, assets[0])); assert.equal(video.mediaType, "video/mp4"); assert(!("bytes" in video));
    await assert.rejects(f.query({ mode: "segment", epoch: "two", record: "record-11", sequence: 11, media: 0, asset: assets[0] }), { status: 404 });
    await assert.rejects(f.query({ mode: "segment", asset: "../video/escape.mp4" }), /无效/);
    await rm(join(f.timeline, assets[0])); await symlink(join(f.run, "events.jsonl"), join(f.timeline, assets[0]));
    await assert.rejects(f.query({ mode: "segment", record: "record-11", sequence: 11, media: 0, asset: assets[0] }), /必须位于/);
  } finally { await f.close(); }
});

test("cold replay frames and video do not wait for full event ingestion or create replay projections", async () => {
  const f = await fixture();
  try {
    const asset = "video/cold.mp4";
    await mkdir(join(f.timeline, "video"));
    await writeFile(join(f.timeline, asset), "video bytes");
    await writeFile(join(f.timeline, asset + ".json"), JSON.stringify({ status: "ready", durationSeconds: 1 }));
    await f.records([{ ms: 15000, channel: "dual", video: [{ asset, pts: 0 }] }], 11);
    const rows = Array.from({ length: 4500 }, (_, i) => JSON.stringify(event(i + 11, 16000, "diagnostic", { text: "x".repeat(1200) })));
    await appendFile(join(f.run, "events.jsonl"), rows.join("\n") + "\n");
    const overview = await f.query({ mode: "overview", epoch: "one" }) as ReplayOverview;
    assert.equal(overview.coverage?.complete, false);
    const index = getLogIndex(f.run), revision = index.eventRevision;
    assert(revision > 10 && revision < 4510);
    const page = await f.query({ mode: "frames", epoch: "one", start: start + 15000, end: start + 17000 }) as ReplayWindow;
    assert(page.frames.some(frame => frame.sequence === 11)); assert.equal(page.items.length, 0);
    const video = await f.query({ mode: "segment", epoch: "one", record: "record-11", sequence: 11, media: 0 }) as FileMedia;
    assert.equal(video.file, join(f.timeline, asset));
    assert.equal(index.eventRevision, revision);
    assert.equal(index.meta("operations:position"), undefined);
    const names = await readdir(index.directory);
    assert(!names.some(name => name.startsWith("replay-")));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(getReplay("project", "run", { mode: "overview" }, f.root, controller.signal), { name: "AbortError" });
    assert.equal(index.eventRevision, revision);
  } finally { await f.close(); }
});

test("fMP4 replay publishes only committed frames and serves immutable byte snapshots while recording", async () => {
  const f = await fixture(), asset = "video/growing.mp4";
  try {
    await mkdir(join(f.timeline, "video"));
    await writeFile(join(f.timeline, asset), Buffer.alloc(1000));
    const publish = (state: Record<string, unknown>) => writeFile(join(f.timeline, asset + ".json"), JSON.stringify({
      status: "pending", format: "fmp4", durationSeconds: 0, readableBytes: 0, lastReadablePts: null, ...state,
    }));
    const segment = { mode: "segment" as const, epoch: "one", record: "record-11", sequence: 11, media: 0 };
    const frames = async () => {
      const page = await f.window({ epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
      return [11, 12, 13].map(sequence => page.frames.find(frame => frame.sequence === sequence)!.media[0].video!);
    };
    await f.records([
      { ms: 15000, channel: "growing", video: [{ asset, pts: 0 }] },
      { ms: 15500, channel: "growing", video: [{ asset, pts: 500000 }] },
      { ms: 15900, channel: "growing", video: [{ asset, pts: 900000, gap: true }] },
    ], 11);
    await publish({});
    let [first, tail, gap] = await frames();
    assert.equal(first.streaming, false); assert.equal(first.revision, "pending:0");
    assert.equal(first.readableUntil, undefined);
    await assert.rejects(f.query(segment), { status: 409 });

    await publish({ readableBytes: 400, lastReadablePts: 0, durationSeconds: 0.5 });
    [first, tail, gap] = await frames();
    assert.equal(first.streaming, true); assert.equal(first.revision, "pending:400");
    assert.equal(first.readableUntil, start + 15000);
    assert.equal(first.durationSeconds, 0.5);
    assert.equal(new URL(first.url, "http://localhost").searchParams.get("bytes"), "400");
    const firstSnapshotUrl = first.url;
    assert.equal(tail.streaming, false); assert.equal(gap.status, "gap");
    const current = await f.query(segment) as FileMedia;
    assert.equal(current.size, 400); assert.equal(current.cacheControl, "no-store");
    const snapshot = await f.query({ ...segment, bytes: 400 }) as FileMedia;
    assert.equal(snapshot.size, 400); assert.match(snapshot.cacheControl!, /immutable/);
    await assert.rejects(f.query({ ...segment, record: "record-12", sequence: 12 }), { status: 409 });
    await assert.rejects(f.query({ ...segment, record: "record-13", sequence: 13 }), { status: 410 });
    for (const bytes of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 401])
      await assert.rejects(f.query({ ...segment, bytes }), { status: 400 });

    await publish({ readableBytes: 800, lastReadablePts: 500000, durationSeconds: 0.9 });
    [first, tail] = await frames();
    assert.equal(tail.streaming, true); assert.equal(tail.readableUntil, start + 15500);
    assert.equal(first.revision, "pending:800");
    assert.notEqual(first.url, firstSnapshotUrl);
    assert.equal((await f.query({ ...segment, bytes: 400 }) as FileMedia).size, 400);

    await publish({ status: "ready", readableBytes: 1000, lastReadablePts: 500000, durationSeconds: 0.9 });
    [first, tail] = await frames();
    assert.equal(first.status, "ready"); assert.equal(first.revision, "ready"); assert.equal(first.streaming, false);
    assert.equal(new URL(first.url, "http://localhost").searchParams.get("bytes"), "1000");
    assert.equal((await f.query(segment) as FileMedia).size, 1000);
    assert.equal((await f.query({ ...segment, bytes: 400 }) as FileMedia).size, 400);
    assert.equal((await f.query({ ...segment, record: "record-12", sequence: 12, bytes: 1000 }) as FileMedia).size, 1000);

    await publish({ status: "error", readableBytes: 800, lastReadablePts: 500000, error: "encoder failed" });
    [first] = await frames();
    assert.equal(first.status, "error"); assert.equal(first.streaming, false);
    await assert.rejects(f.query({ ...segment, bytes: 400 }), { status: 410 });
    await publish({ readableBytes: -1, lastReadablePts: 0 });
    await assert.rejects(frames(), /无效的视频片段读取进度/);
    await assert.rejects(f.query(segment), /无效的视频片段读取进度/);
  } finally { await f.close(); }
});

test("event interval preparation is explicit and never labels unprepared model calls as logs", async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 5100 }, (_, i) => event(i + 11, 10000, "model_start", { model: "sol" }, { modelCallId: `pending-${i}` }));
    rows.push(event(5111, 16000, "perception_observe_end", { status: { state: "ready", generation: "worker" } }));
    await appendFile(join(f.run, "events.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const query = { mode: "events" as const, epoch: "one", start: start + 15000, end: start + 17000 };
    await assert.rejects(f.query(query), { status: 202, code: "ARCHIVE_PREPARING" });
    const frames = await f.query({ ...query, mode: "frames" }) as ReplayWindow;
    assert(frames.frames.length > 0);
    let page = await f.query(query) as ReplayWindow;
    const items = [...page.items];
    while (page.nextCursor) { page = await f.query({ ...query, cursor: page.nextCursor }) as ReplayWindow; items.push(...page.items); }
    assert.equal(items.filter(item => item.track === "model").length, 5100);
    assert(items.filter(item => item.track === "model").every(item => item.status === "pending"));
    assert(items.every(item => typeof item.status === "string"));
  } finally { await f.close(); }
});

test("whole-run bounds use source time extrema instead of the last received event", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(11, -1000, "late")) + "\n");
    const overview = await f.query({ mode: "overview" }) as ReplayOverview;
    assert.equal(overview.startAt, start - 1000); assert.equal(overview.endAt, start + 32000);
    const window = await f.query({ mode: "frames", start: start + 30000, end: start + 32000 }) as ReplayWindow;
    assert(window.frames.some(frame => frame.sequence === 9));
  } finally { await f.close(); }
});

test("frame pages stay bounded with carried channels and exclude later appended samples", async () => {
  const f = await fixture();
  try {
    // Equal-time samples exercise pagination without making frame rate assumptions.
    await f.records(Array.from({ length: 520 }, (_, i) => ({ ms: 16000, channel: "vision" })), 11);
    const query = { mode: "frames" as const, epoch: "one", start: start + 15000, end: start + 17000 };
    const first = await f.query(query) as ReplayWindow;
    assert.equal(first.frames.length, 500); assert(first.nextCursor); assert.equal(first.items.length, 0);
    await f.records([{ ms: 16000, channel: "vision" }], 531);
    const second = await f.query({ ...query, cursor: first.nextCursor }) as ReplayWindow;
    const ids = [...first.frames, ...second.frames].map(frame => frame.sequence);
    assert.equal(ids.length, 522); assert.equal(new Set(ids).size, ids.length);
    assert(!ids.includes(531)); assert.equal(second.nextCursor, undefined);
  } finally { await f.close(); }
});

test("bounded pagination retains equal-time rows and is isolated from appended events", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 1100 }, (_, i) => JSON.stringify(event(i + 11, 16000, "diagnostic"))).join("\n") + "\n");
    const query = { mode: "events" as const, epoch: "one", start: start + 15000, end: start + 17000 };
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
    assert.equal(ids.length, 1100); assert.equal(new Set(ids).size, ids.length);
    await assert.rejects(f.query({ ...query, end: query.end + 1, cursor: first.nextCursor }), /分页游标/);
    const stats = indexCacheStats(); assert(stats.bytes <= stats.limit);
  } finally { await f.close(); }
});

test("a late operation finish cannot change interval membership halfway through a cursor", async () => {
  const f = await fixture();
  try {
    const trace = { traceId: "late", spanId: "span" };
    const rows = Array.from({ length: 500 }, (_, i) => event(i + 11, 16000, "diagnostic"));
    rows.push(event(511, 10000, "action_start", { actionId: "late-finish" }, trace));
    await appendFile(join(f.run, "events.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const query = { mode: "events" as const, epoch: "one", start: start + 15000, end: start + 17000 };
    const first = await f.query(query) as ReplayWindow;
    assert.equal(first.items.length, 500); assert(first.nextCursor);
    // This source event arrives later but says the action ended before the requested window.
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(512, 14000, "action_end", { actionId: "late-finish" }, trace)) + "\n");
    const second = await f.query({ ...query, cursor: first.nextCursor }) as ReplayWindow;
    assert.equal(second.items.length, 1); assert.equal(second.items[0].track, "action");
    assert.equal(second.items[0].status, "pending"); assert.equal(second.items[0].endAt, null);
    const fresh = await f.query(query) as ReplayWindow;
    assert.equal(fresh.items.length, 500); assert.equal(fresh.nextCursor, undefined);
  } finally { await f.close(); }
});

test("record media and details are offline, scoped, canonical and do not copy source bytes", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.run, "events.jsonl"));
    const detail = await f.query({ mode: "detail", epoch: "one", record: "record-5", sequence: 5 }) as ReplayDetail;
    assert.deepEqual((detail.data as { data: unknown }).data, { sample: 5 });
    assert.deepEqual(detail.summary, { kind: "frame", startAt: start + 11000, source: { recordId: "record-5", sequence: 5 }, text: "sample 5" });
    assert.equal(detail.frame?.id, "record-5"); assert.equal(detail.frame?.sequence, 5); assert.equal(detail.frame?.media.length, 2);
    const image = await f.query({ mode: "media", epoch: "one", record: "record-5", sequence: 5, media: 1 }) as { bytes: Buffer };
    assert.equal(image.bytes.toString(), "image:5:1");
    await assert.rejects(f.query({ mode: "media", epoch: "one", record: "record-8", sequence: 8, media: 0 }), /不属于/);
    await assert.rejects(f.query({ mode: "detail", record: "wrong", sequence: 5 }), /不属于/);
    await assert.rejects(getReplay("../project", "run", { mode: "overview" }, f.root), /Invalid workspace ID/);
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
    let page = await f.window({ epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    assert.equal(page.items.find(item => item.source.actionId === "pending")?.endAt, null);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(12, 18000, "action_end", { actionId: "pending", status: "interrupted" }, { traceId: "t2", spanId: "s" })) + "\n");
    page = await f.window({ epoch: "one", start: start + 15000, end: start + 16000 }) as ReplayWindow;
    const span = page.items.find(item => item.source.actionId === "pending")!;
    assert.equal(span.endAt, start + 18000); assert.equal(span.status, "cancelled");
    const detail = await f.query({ mode: "detail", epoch: "one", id: span.id }) as ReplayDetail;
    assert.equal((detail.data as { events: unknown[] }).events.length, 2);
    await f.records([{ ms: 16000, channel: "vision" }], 11);
    page = await f.window({ epoch: "one", start: start + 15000, end: start + 17000 }) as ReplayWindow;
    assert(page.frames.some(frame => frame.sequence === 11));
    assert.equal(getLogIndex(f.run).meta("replay:sequence"), undefined);
    assert.equal(getLogIndex(f.run).meta("replay:position"), undefined);
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

test("canonical replay follows the selected delivery and retains data-only history without nearest-context guesses", async () => {
  const f = await fixture();
  try {
    const rows = [
      event(11, 30100, "perception_observe_end", { queryId: "read", ok: true, query: { id: "record-1" }, records: [{
        id: "record-1", sequence: 1, recordedAt: iso(1000), timeline: { recordId: "record-1", sequence: 1 },
        text: "history", media: [{ id: "frame", mediaType: "image/png", timeline: { recordId: "record-1", sequence: 1,
          asset: `objects/${hash("image:1:0").toString("hex")}.bin` } }],
      }, { id: "record-2", sequence: 2, recordedAt: iso(2000), timeline: { recordId: "record-2", sequence: 2 }, text: "sensor", media: [] }], hasMore: false }, {}, "two"),
      event(12, 30200, "observation_context", { id: "delivery", origin: "explicit", queries: ["read"], observations: ["frame"] }, {}, "two"),
      event(13, 30300, "context", { executions: ["unrelated"], observations: [] }, {}, "two"),
      event(14, 30400, "model_start", { model: "sol", deliveryIds: ["delivery"], observations: ["wrong"] }, { modelCallId: "canonical" }, "two"),
      event(15, 30500, "model_start", { model: "sol", deliveryIds: [], observations: ["frame"] }, { modelCallId: "empty" }, "two"),
    ];
    await appendFile(join(f.run, "events.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const detail = await f.query({ mode: "detail", epoch: "two", id: "event:14" }) as ReplayDetail;
    assert.deepEqual(detail.observations?.map(item => [item.id, item.recordId]), [["frame", "record-1"], ["record-2", "record-2"]]);
    const empty = await f.query({ mode: "detail", epoch: "two", id: "event:15" }) as ReplayDetail;
    assert.deepEqual(empty.observations, []);
  } finally { await f.close(); }
});

test("replay retains delivery failure evidence without turning successful query sources into model input", async () => {
  const f = await fixture();
  try {
    const rows = [
      event(11, 30100, "perception_observe_end", { queryId: "read", ok: true, query: {}, hasMore: false, records: [{
        id: "record-1", sequence: 1, text: "source only", timeline: { recordId: "record-1", sequence: 1 },
        media: [{ id: "frame", mediaType: "image/png" }],
      }, { id: "record-2", sequence: 2, text: "sensor source", timeline: { recordId: "record-2", sequence: 2 }, media: [] }] }, {}, "two"),
      event(12, 30200, "perception_input_error", { queryId: "read", error: "cannot encode" }, {}, "two"),
      event(13, 30300, "observation_context", { id: "failed", origin: "explicit", queries: ["read"], observations: [] }, {}, "two"),
      event(14, 30400, "model_start", { model: "sol", deliveryIds: ["failed"], observations: [] }, { modelCallId: "failure" }, "two"),
    ];
    await appendFile(join(f.run, "events.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const detail = await f.query({ mode: "detail", epoch: "two", id: "event:14" }) as ReplayDetail;
    assert.deepEqual(detail.observations, []);
    assert.equal((detail.data as any).events.find((event: any) => event.type === "perception_input_error")?.data.error, "cannot encode");
  } finally { await f.close(); }
});

test("event windows span fifteen minutes while frames remain bounded to one minute", async () => {
  const f = await fixture();
  try {
    const twoHours = 2 * 60 * 60_000;
    await appendFile(join(f.run, "events.jsonl"), [
      event(11, twoHours - 1000, "action_start", { actionId: "long-action", controllerId: "robot.turn" }, { traceId: "long", spanId: "span" }, "long"),
      event(12, twoHours + 5000, "action_end", { actionId: "long-action" }, { traceId: "long", spanId: "span" }, "long"),
      event(13, 4 * 60 * 60_000, "control", { mode: "manual" }, {}, "long"),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (const duration of [5 * 60_000, 15 * 60_000]) {
      const window = await f.query({ mode: "events", epoch: "all", start: start + twoHours, end: start + twoHours + duration }) as ReplayWindow;
      assert(window.items.some(item => item.source.actionId === "long-action" && item.track === "action"));
      assert.deepEqual(window.frames, []);
    }
    await assert.rejects(f.query({ mode: "events", start, end: start + 15 * 60_000 + 1 }), /15 分钟/);
    await assert.rejects(f.query({ mode: "frames", start, end: start + 60_001 }), /60 秒/);
    const found = await f.query({ mode: "search", q: "  ROBOT.TURN  ", track: "action" }) as ReplaySearchResult;
    assert.equal(found.query, "ROBOT.TURN"); assert.equal(found.items.length, 1);
    assert.equal(found.items[0].startAt, start + twoHours - 1000);
    assert.equal(found.scan.complete, true); assert.equal(found.coverage.complete, true);
  } finally { await f.close(); }
});

test("search matches titles, status and identities without expanding or searching arbitrary artifact bodies", async () => {
  const f = await fixture();
  try {
    const failed = await f.query({ mode: "search", epoch: "one", q: "ERROR", track: "tool" }) as ReplaySearchResult;
    assert.deepEqual(failed.items.map(item => [item.id, item.status, item.source.toolCallId]), [["event:4", "error", "c"]]);
    const byId = await f.query({ mode: "search", q: "event:3", track: "model" }) as ReplaySearchResult;
    assert.deepEqual(byId.items.map(item => item.id), ["event:3"]);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(11, 15000, "private_payload", {
      payload: { encoding: "json", path: "nonexistent-file", content: "hidden-artifact-needle" }, text: "hidden-artifact-needle",
    })) + "\n");
    const absent = await f.query({ mode: "search", q: "hidden-artifact-needle" }) as ReplaySearchResult;
    assert.deepEqual(absent.items, []); assert.equal(absent.scan.complete, true);
    const literal = await f.query({ mode: "search", q: ".*|[", track: "all" }) as ReplaySearchResult;
    assert.deepEqual(literal.items, []);
    await assert.rejects(f.query({ mode: "search", q: "x".repeat(201) }), /200/);
    await assert.rejects(f.query({ mode: "search", track: "video" as never }), /轨道/);
  } finally { await f.close(); }
});

test("a sparse full-run search returns an empty bounded page with continuation", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 1200 }, (_, i) => JSON.stringify(event(i + 11, 16000,
      i === 1100 ? "needle-at-the-end" : "diagnostic"))).join("\n") + "\n");
    await f.query({ mode: "events", start, end: start + 60000 });
    resetStorageMetrics();
    const query = { mode: "search" as const, q: "needle-at-the-end", track: "log" as const };
    let page = await f.query(query) as ReplaySearchResult;
    assert.deepEqual(page.items, []); assert(page.nextCursor); assert.equal(page.scan.complete, false);
    assert.equal(page.scan.throughPosition, 500); assert.equal(page.scan.totalPositions, 1210);
    assert(storageMetrics.sourceReadCalls <= 520, "bounded candidate bodies plus small scope metadata");
    const found: ReplaySearchResult["items"] = [...page.items];
    while (page.nextCursor) { page = await f.query({ ...query, cursor: page.nextCursor }) as ReplaySearchResult; found.push(...page.items); }
    assert.deepEqual(found.map(item => item.id), ["event:1111"]); assert.equal(page.scan.complete, true);
  } finally { await f.close(); }
});

test("search cursors bind query, track, epoch and generation and exclude later appended matches", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 230 }, (_, i) => JSON.stringify(event(i + 11, 16000, "search_marker"))).join("\n") + "\n");
    const query = { mode: "search" as const, epoch: "one", q: "search_marker", track: "log" as const };
    const first = await f.query(query) as ReplaySearchResult;
    assert.equal(first.items.length, 100); assert(first.nextCursor);
    for (const patch of [{ q: "other" }, { track: "model" as const }, { epoch: "two" }])
      await assert.rejects(f.query({ ...query, ...patch, cursor: first.nextCursor }), /搜索游标/);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(241, 16000, "search_marker")) + "\n");
    let page = first; const found = [...first.items];
    while (page.nextCursor) { page = await f.query({ ...query, cursor: page.nextCursor }) as ReplaySearchResult; found.push(...page.items); }
    assert.equal(found.length, 230); assert.equal(new Set(found.map(item => item.id)).size, 230);
    assert.equal(page.scan.totalPositions, 240); assert.equal(page.scan.throughPosition, 240);
    const fresh = await f.query(query) as ReplaySearchResult; assert.equal(fresh.scan.totalPositions, 241);
    await writeFile(join(f.run, "events.jsonl"), [event(1, 0, "control", { mode: "auto" }), event(2, 20000, "control", { mode: "manual" })].map(row => JSON.stringify(row)).join("\n") + "\n");
    await assert.rejects(f.query({ ...query, cursor: first.nextCursor }), /搜索游标/);
  } finally { await f.close(); }
});

test("search snapshot retains pending operations when a later finish changes current status", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 500 }, (_, i) => JSON.stringify(event(i + 11, 16000, "diagnostic"))).join("\n") + "\n"
      + JSON.stringify(event(511, 10000, "action_start", { actionId: "late-finish" }, { traceId: "late", spanId: "span" })) + "\n");
    const query = { mode: "search" as const, epoch: "one", track: "action" as const, q: "pending" };
    const first = await f.query(query) as ReplaySearchResult; assert(first.nextCursor); assert.equal(first.items.length, 0);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(512, 14000, "action_end", { actionId: "late-finish", status: "completed" }, { traceId: "late", spanId: "span" })) + "\n");
    const next = await f.query({ ...query, cursor: first.nextCursor }) as ReplaySearchResult;
    assert.equal(next.items.length, 1); assert.equal(next.items[0].status, "pending"); assert.equal(next.items[0].endAt, null);
    let current = await f.query({ ...query, q: "completed" }) as ReplaySearchResult;
    const completed = [...current.items];
    while (current.nextCursor) { current = await f.query({ ...query, q: "completed", cursor: current.nextCursor }) as ReplaySearchResult; completed.push(...current.items); }
    assert(completed.some(item => item.source.actionId === "late-finish"));
  } finally { await f.close(); }
});

test("a completed search over an indexed prefix never claims the whole archive was searched", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 3000 }, (_, i) => JSON.stringify(event(i + 11, 16000, "diagnostic", { payload: "x".repeat(2100) }))).join("\n") + "\n");
    const query = { mode: "search" as const, epoch: "one", q: "no-matches" };
    const first = await f.query(query) as ReplaySearchResult;
    assert.equal(first.coverage.complete, false); assert(first.coverage.bytes < first.coverage.totalBytes); assert(first.nextCursor);
    let page = first;
    while (page.nextCursor) {
      page = await f.query({ ...query, cursor: page.nextCursor }) as ReplaySearchResult;
      assert.deepEqual(page.coverage, first.coverage); assert.equal(page.scan.totalPositions, first.scan.totalPositions);
    }
    assert.equal(page.scan.complete, true); assert.equal(page.coverage.complete, false);
    const fresh = await f.query(query) as ReplaySearchResult;
    assert.equal(fresh.coverage.complete, true); assert(fresh.scan.totalPositions > first.scan.totalPositions);
  } finally { await f.close(); }
});

test("typed event details expose bounded explicit text while retaining original evidence", async () => {
  const f = await fixture();
  try {
    const detail = await f.query({ mode: "detail", epoch: "one", id: "event:4" }) as ReplayDetail;
    assert.equal(detail.item?.id, "event:4"); assert.equal(detail.summary?.kind, "tool");
    assert.equal(detail.summary?.status, "error"); assert.equal(detail.summary?.source.toolCallId, "c");
    assert.equal(detail.summary?.text, undefined);
    const text = "sample ".repeat(400);
    await appendFile(join(f.run, "events.jsonl"), JSON.stringify(event(11, 15000, "text", { text })) + "\n");
    const message = await f.query({ mode: "detail", epoch: "one", id: "event:11" }) as ReplayDetail;
    assert.equal(message.summary?.text, text.slice(0, 2000)); assert.equal(message.summary?.textTruncated, true);
    assert.equal((message.data as { events: { data: { text: string } }[] }).events[0].data.text, text);
  } finally { await f.close(); }
});

test("search refuses a continuation in a different run or workspace and validates cursor positions", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 120 }, (_, i) => JSON.stringify(event(i + 11, 16000, "marker"))).join("\n") + "\n");
    const query = { mode: "search" as const, q: "marker" };
    const first = await f.query(query) as ReplaySearchResult; assert(first.nextCursor);
    const otherRun = join(f.workspace, "logs/other"); await mkdir(otherRun);
    await writeFile(join(otherRun, "manifest.json"), JSON.stringify({ workspace: f.workspace, workspaceId: "project", runId: "other" }));
    await writeFile(join(otherRun, "events.jsonl"), await readFile(join(f.run, "events.jsonl")));
    await assert.rejects(getReplay("project", "other", { ...query, cursor: first.nextCursor }, f.root), /搜索游标/);
    const otherWorkspace = join(f.root, "other-workspace"), other = join(otherWorkspace, "logs/run");
    await mkdir(other, { recursive: true }); await registerFixture(f.root, "other-project", otherWorkspace);
    await writeFile(join(other, "manifest.json"), JSON.stringify({ workspace: otherWorkspace, workspaceId: "other-project", runId: "run" }));
    await writeFile(join(other, "events.jsonl"), await readFile(join(f.run, "events.jsonl")));
    await assert.rejects(getReplay("other-project", "run", { ...query, cursor: first.nextCursor }, f.root), /搜索游标/);
    const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    for (const after of [-1, cursor.events + 1, 1.5])
      await assert.rejects(f.query({ ...query, cursor: Buffer.from(JSON.stringify({ ...cursor, after })).toString("base64url") }), /搜索游标/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(getReplay("project", "run", query, f.root, controller.signal), { name: "AbortError" });
  } finally { await f.close(); }
});

test("search reports operation preparation explicitly without blocking recorded frame reads", async () => {
  const f = await fixture();
  try {
    await appendFile(join(f.run, "events.jsonl"), Array.from({ length: 5100 }, (_, i) => JSON.stringify(event(i + 11, 10000, "model_start", { model: "sol" }, { modelCallId: `pending-${i}` }))).join("\n") + "\n");
    const query = { mode: "search" as const, epoch: "one", q: "sol", track: "model" as const };
    await assert.rejects(f.query(query), { status: 202, code: "ARCHIVE_PREPARING" });
    const frames = await f.query({ mode: "frames", epoch: "one", start, end: start + 20000 }) as ReplayWindow;
    assert(frames.frames.length > 0);
    const page = await f.query(query) as ReplaySearchResult;
    assert.equal(page.items.length, 100); assert(page.nextCursor);
    assert(page.items.every(item => item.track === "model"));
  } finally { await f.close(); }
});
