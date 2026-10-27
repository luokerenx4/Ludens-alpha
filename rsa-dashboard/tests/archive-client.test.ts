import test from "node:test";
import assert from "node:assert/strict";
import { readArchiveJson } from "../lib/archive-client";

test("archive preparation is retried rather than consumed as an empty history response", async () => {
  const previous = global.fetch; let calls = 0;
  global.fetch = async () => ++calls === 1 ? Response.json({ code: "ARCHIVE_PREPARING", progress: { bytes: 10, totalBytes: 100 } }, { status: 202 })
    : Response.json({ blocks: [{ id: "historical" }] });
  try { assert.deepEqual(await readArchiveJson("http://localhost/api/activity"), { blocks: [{ id: "historical" }] }); assert.equal(calls, 2); }
  finally { global.fetch = previous; }
});

test("leaving the view cancels preparation retries without another HTTP request", async () => {
  const previous = global.fetch; let calls = 0;
  const controller = new AbortController();
  global.fetch = async () => { calls++; setTimeout(() => controller.abort(), 5);
    return Response.json({ code: "ARCHIVE_PREPARING" }, { status: 202 }); };
  try { await assert.rejects(readArchiveJson("http://localhost/api/run", controller.signal), { name: "AbortError" }); assert.equal(calls, 1); }
  finally { global.fetch = previous; }
});
