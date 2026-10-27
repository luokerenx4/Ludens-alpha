import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { childTrace, EventLog } from "../src/harness/events.ts";

test("run events have ordered identities and immutable, lossless payload references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-events-"));
  let time = 0;
  const log = new EventLog(directory, { id: "run-test", now: () => ++time });
  try {
    const payload = { messages: [{ role: "user", content: "中文\nimage:data:image/png;base64,abcd" }], tools: [], thinking: { type: "enabled" } };
    const ref = log.artifact(payload);
    expect(log.artifact(payload)).toEqual(ref);
    log.record("model_request", { payload: ref }, { epoch: "epoch", modelCallId: "call", requestId: "request" });
    payload.messages[0].content = "changed later";
    log.record("model_end", { stopReason: "stop" }, { epoch: "epoch", modelCallId: "call", requestId: "request" });
    const decoded = gunzipSync(await readFile(join(directory, ref.path)));
    expect(new Bun.SHA256().update(decoded).digest("hex")).toBe(ref.sha256);
    expect(JSON.parse(decoded.toString()).messages[0].content).toContain("中文\nimage:");
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.seq)).toEqual([1, 2]);
    expect(events.map(e => e.atMs)).toEqual([1, 2]);
    expect(events.every(e => e.runId === "run-test" && e.schemaVersion === 2 && e.trace.requestId === "request")).toBe(true);
    expect(events[0].source).toEqual({ component: "rsa" });
    expect(events[0].origin).toEqual({ eventId: "run-test:1", clockId: "run-test", seq: 1, at: events[0].at, atMs: 1 });

    const deviceOrigin = { eventId: "device:7", clockId: "device", seq: 7, at: "2026-10-19T00:00:00.000Z", atMs: 500 };
    const parent = childTrace({ epoch: "epoch" });
    const child = childTrace(parent);
    log.record("execution", { status: "completed" }, child, { source: { component: "baseware" }, origin: deviceOrigin });
    const forwarded = JSON.parse((await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").at(-1)!);
    expect(forwarded.origin).toEqual(deviceOrigin);
    expect(forwarded.atMs).toBe(3);
    expect(forwarded.trace.traceId).toBe(parent.traceId);
    expect(forwarded.trace.parentSpanId).toBe(parent.spanId);
    expect(forwarded.trace.spanId).not.toBe(parent.spanId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed video registration is diagnosed without terminating the host event callback", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rsa-video-reference-"));
  const directory = join(workspace, "logs", "run");
  await mkdir(directory, { recursive: true });
  try {
    const log = new EventLog(directory, { id: "fixture", now: () => 1 }, workspace);
    log.registerMedia({ sha256: "a".repeat(64), asset: "video/f0.mp4",
      video: { pts: 0, timeBase: [1, 1000000], width: 32769, height: 1 } });
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(["media_reference_error"]);
    expect(events[0].data.error).toContain("Invalid timeline video frame reference");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
