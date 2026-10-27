import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { media } from "../src/harness/omp/extension.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { decodeTimelineFrame } from "../../shared/timeline-media.ts";

test("model image versions reference one video source and archive errors do not alter model input", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-derived-media-")));
  const events: { type: string; data: any }[] = [];
  const record = (type: string, data: unknown) => { events.push({ type, data }); };
  const registered: any[] = [];
  const runtime = new PerceptionRuntime({ workspace, runDir: join(workspace, "logs", "run"), record,
    registerMedia: media => { registered.push(media); } });
  const signal = new AbortController().signal;
  try {
    await runtime.reload(); // Writer remains available without a user's sampler.
    const png = encodeRawPng(new Uint8Array(32 * 32 * 3).fill(80), 32, 32, 3);
    const input = { sample: { media: [{ data: Buffer.from(png).toString("base64"), mediaType: "image/png" }] },
      identity: { id: "python/camera.py:sample" }, sampling: { clock: "fixture", startedAtMs: 1, finishedAtMs: 2 } };
    const first = await runtime.append(input, signal) as { timeline: { recordId: string } };
    await runtime.append(input, signal); // Identical pixels, distinct source record.
    const read = await runtime.observe(signal, {}, { id: first.timeline.recordId });
    const observation = read.result.observations![0]!;
    const actual = await media([observation], record, {}, value => runtime.deriveMedia(value, signal));
    expect(actual[0]?.type).toBe("image");
    const encoded = actual[0] as { data: string; mimeType: string };
    const saved = events.findLast(event => event.type === "observation_media")!.data.modelMedia;
    expect(saved).toMatchObject({ recordId: first.timeline.recordId, sequence: 1,
      sourceAsset: observation.timeline!.asset, transform: "omp.resizeImage", mediaType: encoded.mimeType });
    expect(saved.asset).toBe(observation.timeline!.asset);
    expect(saved.video).toEqual(observation.timeline!.video);
    expect(saved.approximate).toBe(true);
    expect(observation.path).toBeUndefined();
    expect(Buffer.from(observation.data!, "base64")).toEqual(Buffer.from(png));

    const invalid = { ...observation, timeline: { ...observation.timeline!, recordId: "missing-record" } };
    const unarchived = await media([invalid], record, {}, value => runtime.deriveMedia(value, signal));
    expect(unarchived).toEqual(actual);
    const failure = events.findLast(event => event.type === "observation_media")!.data;
    expect(failure.modelMedia).toBeUndefined();
    expect(failure.archiveError).toContain("record is missing or expired");

    let calls = 0;
    expect(await media([{ ...observation, timeline: undefined }], record, {}, async () => { calls++; throw Error("unexpected"); }))
      .toEqual(actual);
    expect(calls).toBe(0); // An unrecorded image cannot acquire persistence here.
    expect(registered.some(entry => entry.asset === saved.asset)).toBe(true);
    expect(events.some(event => ["timeline_media", "perception_sample"].includes(event.type))).toBe(false);
    await runtime.stop();
    const root = join(workspace, ".rsa", "timeline");
    expect(JSON.parse(await readFile(join(root, saved.asset + ".json"), "utf8")).status).toBe("ready");
    const decoded = await decodeTimelineFrame(root, saved);
    expect(decoded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(decoded.readUInt32BE(16)).toBe(32);
    expect(decoded.readUInt32BE(20)).toBe(32);
    expect(await readdir(join(root, "objects")).catch(() => [])).toEqual([]);
    await runtime.reload();
    const cold = await runtime.observe(signal, {}, { id: first.timeline.recordId });
    expect(cold.error).toBeUndefined();
    const coldImage = cold.result.observations![0]!;
    expect(Buffer.from(coldImage.data!, "base64").equals(decoded)).toBe(true);
    expect(registered.at(-1)).toMatchObject({
      asset: saved.asset, video: saved.video, approximate: true,
      sha256: createHash("sha256").update(decoded).digest("hex"), bytes: decoded.length,
    });
  } finally {
    await runtime.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("offline frame reads distinguish an unfinished segment from lost recording", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-pending-video-")));
  const reference = { asset: "video/abcd.mp4", video: { pts: 0, timeBase: [1, 1000000] as [number, number], width: 32, height: 32 } };
  try {
    await mkdir(join(root, "video"));
    await writeFile(join(root, reference.asset + ".json"), JSON.stringify({ status: "pending" }));
    await expect(decodeTimelineFrame(root, reference)).rejects.toMatchObject({ status: 409 });
    await writeFile(join(root, reference.asset + ".json"), JSON.stringify({ status: "error", error: "encoding interrupted" }));
    await expect(decodeTimelineFrame(root, reference)).rejects.toMatchObject({ status: 410 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
