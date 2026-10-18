import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { EventLog } from "../src/harness/events.ts";

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
    expect(events.every(e => e.runId === "run-test" && e.schemaVersion === 1 && e.trace.requestId === "request")).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
