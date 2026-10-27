import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteRange, fileResponse } from "../lib/file-response";

test("media ranges cover full, suffix, open, invalid, HEAD and cancelled reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-media-range-")), file = join(directory, "video.mp4");
  await writeFile(file, "0123456789");
  const media = { file, mediaType: "video/mp4" };
  const request = (range?: string, method = "GET") => new Request("http://localhost/media", { method,
    headers: range ? { Range: range } : undefined });
  try {
    assert.equal(await (await fileResponse(request(), media)).text(), "0123456789");
    for (const [range, expected] of [["bytes=2-5", "2345"], ["bytes=7-", "789"], ["bytes=-3", "789"], ["bytes=7-999", "789"]]) {
      const response = await fileResponse(request(range), media);
      assert.equal(response.status, 206); assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(await response.text(), expected);
    }
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=", "bytes=0-1,3-4", "bytes=9007199254740992-"]) {
      const response = await fileResponse(request(range), media);
      assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), "bytes */10");
    }
    const head = await fileResponse(request("bytes=2-5", "HEAD"), media);
    assert.equal(head.status, 206); assert.equal(head.headers.get("content-length"), "4"); assert.equal(await head.text(), "");
    const body = (await fileResponse(request(), media)).body!;
    await body.cancel();
    assert.throws(() => byteRange("bytes=0-", 0), RangeError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a range from an 8 GiB sparse video does not allocate the video in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-large-video-")), file = join(directory, "video.mp4");
  const handle = await open(file, "w");
  await handle.truncate(8 * 1024 ** 3); await handle.write(Buffer.from("tail"), 0, 4, 8 * 1024 ** 3 - 4); await handle.close();
  try {
    const before = process.memoryUsage();
    const response = await fileResponse(new Request("http://localhost/media", { headers: { Range: "bytes=-4" } }), { file, mediaType: "video/mp4" });
    assert.equal(response.status, 206); assert.equal(await response.text(), "tail");
    assert.equal(response.headers.get("content-range"), `bytes ${8 * 1024 ** 3 - 4}-${8 * 1024 ** 3 - 1}/${8 * 1024 ** 3}`);
    assert(process.memoryUsage().arrayBuffers - before.arrayBuffers < 4 * 1024 ** 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
