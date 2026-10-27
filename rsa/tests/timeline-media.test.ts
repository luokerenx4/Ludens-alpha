import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { media } from "../src/harness/omp/extension.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";

test("model image versions retain the requested record and archive errors do not alter model input", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-derived-media-")));
  const events: { type: string; data: any }[] = [];
  const record = (type: string, data: unknown) => { events.push({ type, data }); };
  const runtime = new PerceptionRuntime({ workspace, runDir: join(workspace, "logs", "run"), record });
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
    expect(saved.asset).not.toBe(observation.timeline!.asset);
    expect(await readFile(join(workspace, ".rsa", "timeline", saved.asset)))
      .toEqual(Buffer.from(encoded.data, "base64"));
    expect(await readFile(observation.path!)).toEqual(Buffer.from(png));

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
  } finally {
    await runtime.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});
