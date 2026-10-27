import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { JsonArchive, readArtifact, readArtifactSync } from "../../shared/log-archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "rsa-log-archive-")); roots.push(workspace);
  const run = join(workspace, "logs", "one"); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "manifest.json"), JSON.stringify({ workspace }));
  return { workspace, run, store: new JsonArchive(workspace) };
}
function retained(workspace: string, bytes: Buffer, window = "objects") {
  const sha256 = createHash("sha256").update(bytes).digest("hex"), asset = `${window}/${sha256}.bin`;
  const path = join(workspace, ".rsa", "timeline", asset);
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes);
  return { sha256, asset, path, bytes: bytes.length };
}

test("tagged JSON preserves special keys, original reference-shaped values and exact strings", async () => {
  const { run, store } = setup();
  const value = JSON.parse('{"__proto__":{"admin":true},"$ref":"objects/nope","type":"ref","nested":[false,null,5,"\\n\\t"]}');
  const ref = store.write(value);
  expect(await readArtifact(run, ref)).toEqual(value);
  expect(readArtifactSync(run, ref)).toEqual(value);
  expect(Object.prototype.hasOwnProperty.call(await readArtifact(run, ref), "__proto__")).toBe(true);
  expect(({} as any).admin).toBeUndefined();
});

test("shared messages and tool definitions survive cross-run reads without copying history", async () => {
  const { workspace, run, store } = setup();
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `message-${i}:` + "history ".repeat(1200) }));
  const first = store.write({ model: "fixture", input: messages });
  const objects = join(store.root, "objects");
  const before = new Set(readdirSync(objects));
  const second = new JsonArchive(workspace).write({ model: "fixture", input: [...messages, { role: "user", content: "new" }] });
  const added = readdirSync(objects).filter(file => !before.has(file));
  expect(added.length).toBeLessThanOrEqual(3);
  const run2 = join(workspace, "logs", "two"); mkdirSync(run2); writeFileSync(join(run2, "manifest.json"), JSON.stringify({ workspace }));
  expect(await readArtifact(run2, first)).toEqual({ model: "fixture", input: messages });
  expect(readArtifactSync(run, second).input.at(-1)).toEqual({ role: "user", content: "new" });
  expect(added.reduce((sum, file) => sum + statSync(join(objects, file)).size, 0)).toBeLessThan(10_000);
});

test("small stream deltas stay inline while large history is shared and checksummed", async () => {
  const { run, store } = setup();
  const small = store.write({ type: "delta", text: "hello" }, { inline: true });
  expect(small).toHaveProperty("inline");
  expect(readdirSync(join(store.root, "objects"))).toEqual([]);
  expect(await readArtifact(run, small)).toEqual({ type: "delta", text: "hello" });
  await expect(readArtifact(run, { ...small, inline: ["v", "changed"] })).rejects.toThrow("checksum");
  const large = store.write({ content: "history".repeat(2000) }, { inline: true });
  expect(readdirSync(join(store.root, "objects")).length).toBeGreaterThan(0);
  expect(await readArtifact(run, large)).toEqual({ content: "history".repeat(2000) });
});

test("media is referenced once across native fields, data URLs and JSON encoded tool text", async () => {
  const { workspace, run, store } = setup();
  const bytes = Buffer.from("fixture pixel bytes".repeat(500));
  const source = retained(workspace, bytes);
  const data = bytes.toString("base64");
  const native = { type: "image", mimeType: "image/png", data };
  const value = { content: [native, { type: "input_image", image_url: `data:image/png;base64,${data}` },
    { type: "text", text: JSON.stringify({ content: [native] }, null, 2) }] };
  const ref = store.write(value);
  expect(await readArtifact(run, ref, { media: "full" })).toEqual(value);
  expect(readArtifactSync(run, ref, { media: "full" })).toEqual(value);
  const projection = await readArtifact(run, ref);
  expect(projection.content[0].data.$media.asset).toBe(source.asset);
  expect(projection.content[2].text).toContain("[media:");
  for (const file of readdirSync(join(store.root, "objects"))) {
    const content = gunzipSync(readFileSync(join(store.root, "objects", file))).toString("utf8");
    expect(content).not.toContain(data);
  }
  rmSync(source.path);
  // Text inspection never needs even an extant media file.
  expect((await readArtifact(run, ref)).content[0].data.$media.sha256).toBe(source.sha256);
  await expect(readArtifact(run, ref, { media: "full" })).rejects.toThrow("Media unavailable");
});

test("window media remains temporary and unrecorded media is never archived by logging", async () => {
  const { workspace, run, store } = setup();
  const data = Buffer.from("temporal frame");
  const source = retained(workspace, data, "window-42-test"); store.registerMedia(source);
  const input = { type: "image", mimeType: "image/png", data: data.toString("base64") };
  const ref = store.write(input);
  expect(await readArtifact(run, ref, { media: "full" })).toEqual(input);
  rmSync(source.path);
  await expect(readArtifact(run, ref, { media: "full" })).rejects.toThrow("Media unavailable");
  const unknown = store.write({ type: "audio", mimeType: "audio/wav", data: Buffer.from("not retained").toString("base64") });
  expect((await readArtifact(run, unknown)).data.$media.status).toBe("unrecorded");
  await expect(readArtifact(run, unknown, { media: "full" })).rejects.toThrow("Media unavailable");
  expect(readdirSync(join(workspace, ".rsa", "timeline"))).toEqual(["window-42-test"]);
});

test("nested native audio and base64 source blocks use the same media contract", async () => {
  const { workspace, run, store } = setup();
  const bytes = Buffer.from("audio or source bytes".repeat(200)), data = bytes.toString("base64");
  const source = retained(workspace, bytes);
  const blocks = [
    { type: "input_audio", input_audio: { data, format: "wav" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
  ];
  const ref = store.write({ blocks, text: JSON.stringify(blocks) });
  expect(await readArtifact(run, ref, { media: "full" })).toEqual({ blocks, text: JSON.stringify(blocks) });
  const display = await readArtifact(run, ref);
  expect(display.blocks[0].input_audio.data.$media.asset).toBe(source.asset);
  expect(display.blocks[1].source.data.$media.asset).toBe(source.asset);
  for (const file of readdirSync(join(store.root, "objects")))
    expect(gunzipSync(readFileSync(join(store.root, "objects", file))).toString()).not.toContain(data);
});

test("offline CLI reads event references without a runtime and reports unavailable media", async () => {
  const { run, store } = setup();
  const ref = store.write({ text: "inspect me", image: { type: "image", data: Buffer.from("unrecorded").toString("base64") } });
  writeFileSync(join(run, "events.jsonl"), JSON.stringify({ seq: 9, data: { payload: ref } }) + "\n");
  const command = join(import.meta.dir, "../src/app/main.ts");
  const call = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, command, "logs", "read", "--run", run, ...args], {
      cwd: run, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const display = await call("--event", "9", "--field", "payload");
  expect(display.code).toBe(0);
  expect(JSON.parse(display.stdout).image.data.$media.reason).toBe("not-retained");
  expect(readdirSync(run).sort()).toEqual(["events.jsonl", "manifest.json"]);
  const full = await call("--ref", JSON.stringify(ref), "--full");
  expect(full.code).not.toBe(0);
  expect(full.stderr).toContain("Media unavailable");
});

test("JSON escaping cannot hide a media copy and exact original string spelling survives", async () => {
  const { workspace, run, store } = setup();
  const bytes = Buffer.from([255, 255, 255, 4, 5, 6]), data = bytes.toString("base64");
  retained(workspace, bytes);
  const raw = '{ "image": {"type":"image", "data": "' + data.replaceAll("/", "\\/").replace("B", "\\u0042") + '"}}';
  const url = JSON.stringify({ text: '¯ line\n"caption" data:image/png;base64,' + data }).replaceAll("/", "\\/").replace("¯", "\\u00Af");
  const ref = store.write({ raw, url });
  expect(await readArtifact(run, ref, { media: "full" })).toEqual({ raw, url });
  expect(readArtifactSync(run, ref, { media: "full" })).toEqual({ raw, url });
  for (const file of readdirSync(join(store.root, "objects"))) {
    const object = gunzipSync(readFileSync(join(store.root, "objects", file))).toString();
    expect(object).not.toContain(data);
    expect(object).not.toContain(data.replaceAll("/", "\\/"));
  }
  const unretained = JSON.stringify({ type: "image", data: Buffer.from("unrecorded").toString("base64") }).replace("d", "\\u0064");
  await expect(readArtifact(run, store.write({ text: unretained }), { media: "full" })).rejects.toThrow("Media unavailable");
});

test("writers reject replaced archive directories and corrupted existing objects", () => {
  const { workspace, store } = setup();
  const value = { text: "integrity" }, ref = store.write(value);
  writeFileSync(join(store.root, ref.path), gzipSync("wrong"));
  expect(() => store.write(value)).toThrow("checksum");
  rmSync(join(store.root, "objects"), { recursive: true });
  const outside = join(workspace, "outside"); mkdirSync(outside); symlinkSync(outside, join(store.root, "objects"));
  expect(() => store.write({ fresh: true })).toThrow("canonical");
  expect(readdirSync(outside)).toEqual([]);
});

test("readers validate ownership, content hashes and canonical paths; legacy payloads stay readable", async () => {
  const { workspace, run, store } = setup();
  const ref = store.write({ content: "hello" });
  await expect(readArtifact(run, ref, { workspace: null })).rejects.toThrow("not authorized");
  await expect(readArtifact(run, { ...ref, path: "../../bad" })).rejects.toThrow("reference");
  const path = join(store.root, ref.path), bytes = readFileSync(path);
  writeFileSync(path, gzipSync('{"version":1,"node":["v","tampered"]}'));
  await expect(readArtifact(run, ref)).rejects.toThrow("checksum"); writeFileSync(path, bytes);
  const outside = join(workspace, "external.json.gz"); writeFileSync(outside, bytes); rmSync(path); symlinkSync(outside, path);
  await expect(readArtifact(run, ref)).rejects.toThrow("canonical");
  expect(() => store.write({ content: "hello" })).toThrow("symlink");
  mkdirSync(join(run, "payloads"));
  const legacyPath = `payloads/${"a".repeat(64)}.json.gz`;
  writeFileSync(join(run, legacyPath), gzipSync(JSON.stringify({ old: true })));
  expect(await readArtifact(run, { path: legacyPath, encoding: "gzip" }, { workspace: null })).toEqual({ old: true });
});

test("video references avoid duplicate image blobs and never impersonate exact model bytes", async () => {
  const { workspace, run, store } = setup();
  const bytes = Buffer.from("model image bytes already delivered");
  const sha256 = new Bun.SHA256().update(bytes).digest("hex");
  const video = { pts: 120000, timeBase: [1, 1000000] as [number, number], width: 32, height: 32 };
  const source = { sha256, asset: "video/01234567-abcd.mp4", video };
  store.registerMedia(source);
  const ref = store.write({ image: { type: "image", data: bytes.toString("base64"), mimeType: "image/png" } });
  const value = await readArtifact(run, ref);
  expect(value.image.data.$media).toMatchObject({ ...source, approximate: true, status: "referenced" });
  await expect(readArtifact(run, ref, { media: "full" })).rejects.toThrow("lossy-video-source");
  expect(() => readArtifactSync(run, ref, { media: "full" })).toThrow("lossy-video-source");
  for (const file of readdirSync(join(store.root, "objects")))
    expect(gunzipSync(readFileSync(join(store.root, "objects", file))).toString()).not.toContain(bytes.toString("base64"));
  store.registerMedia({ ...source, video: { ...video, status: "gap", reason: "queue-full" } });
  expect((await readArtifact(run, store.write({ type: "image", data: bytes.toString("base64") }))).data.$media)
    .toMatchObject({ status: "referenced", asset: source.asset });
  for (let index = 0; index < 4100; index++) store.registerMedia({ ...source,
    sha256: createHash("sha256").update(String(index)).digest("hex"), video: { ...video, pts: index } });
  expect(readdirSync(join(store.root, "media"))).toEqual([`${sha256}.json`]); // Samples alone do not create lookup files.
  for (const archive of [store, new JsonArchive(workspace)])
    expect((await readArtifact(run, archive.write({ type: "image", data: bytes.toString("base64") }))).data.$media)
      .toMatchObject({ ...source, status: "referenced" });
  const missed = Buffer.from("different unrecorded pixels");
  store.registerMedia({ ...source, sha256: createHash("sha256").update(missed).digest("hex"),
    video: { ...video, status: "gap", reason: "queue-full" } });
  expect((await readArtifact(run, store.write({ type: "image", data: missed.toString("base64") }))).data.$media)
    .toMatchObject({ status: "unrecorded", reason: "queue-full" });
  expect(() => store.registerMedia({ ...source, asset: "video/../../outside.mp4" })).toThrow("Invalid timeline video");
});

test("video lookup renews temporary or failed sources while keeping a healthy durable source stable", async () => {
  const { workspace, run, store } = setup();
  const bytes = Buffer.from("same pixels across recording attempts");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const video = { pts: 0, timeBase: [1, 1000000] as [number, number], width: 32, height: 32 };
  const value = { type: "image", data: bytes.toString("base64") };
  const use = async (asset: string) => {
    store.registerMedia({ sha256, asset, video });
    return (await readArtifact(run, store.write(value))).data.$media.asset;
  };
  expect(await use("window-1/video/aaaa.mp4")).toBe("window-1/video/aaaa.mp4");
  expect(await use("window-2/video/bbbb.mp4")).toBe("window-2/video/bbbb.mp4");
  expect(await use("video/cccc.mp4")).toBe("video/cccc.mp4");
  const state = join(workspace, ".rsa/timeline/video/cccc.mp4.json");
  mkdirSync(join(state, ".."), { recursive: true });
  writeFileSync(state, JSON.stringify({ status: "ready" }));
  expect(await use("video/dddd.mp4")).toBe("video/cccc.mp4");
  writeFileSync(state, JSON.stringify({ status: "error" }));
  expect(await use("video/dddd.mp4")).toBe("video/dddd.mp4");
  writeFileSync(join(store.root, "media", `${sha256}.json`), "broken index");
  expect(() => new JsonArchive(workspace).write(JSON.stringify(value))).toThrow(); // Never fall back to retaining raw image JSON.
});
