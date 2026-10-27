import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogIndex } from "../lib/log-index";
import { refreshOperationIndex, queryOperationRefs, getOperation } from "../lib/operation-index";
import type { Event } from "../lib/types";

test("sparse intervals retain late terminal evidence and overlap without copying log bodies", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rsa-intervals-")));
  let index: LogIndex | undefined;
  const event = (seq: number, type: string, at: number, data: Record<string, unknown> = {}): Event => ({ seq,
    type, at: new Date(at).toISOString(), atMs: at, trace: { epoch: "one", modelCallId: "model", toolCallId: "tool",
      traceId: "trace", spanId: "span" }, data });
  try {
    await writeFile(join(path, "events.jsonl"), [event(1, "model_start", 1000),
      event(2, "tool_start", 1100, { toolName: "bash", args: { command: "large body" } }),
      event(3, "action_start", 1200, { actionId: "move" }), event(4, "telemetry", 1300)].map(e => JSON.stringify(e)).join("\n") + "\n");
    index = new LogIndex(path, join(path, "index")); await index.refreshEvents(); await refreshOperationIndex(index);
    assert.equal((await queryOperationRefs(index, { epoch: "one", start: 2000, end: 3000 })).length, 3);
    const terminal = event(5, "action_end", 20_000, { actionId: "move", status: "completed" });
    terminal.origin = { eventId: "remote", clockId: "device", seq: 5, at: new Date(2500).toISOString(), atMs: 2500 };
    await appendFile(join(path, "events.jsonl"), JSON.stringify(terminal) + "\n");
    await index.refreshEvents(); await refreshOperationIndex(index);
    const operation = await getOperation(index, 3);
    assert.equal(operation?.endPosition, 5); assert.equal(operation?.endAt, new Date(2500).toISOString());
    assert.equal(operation?.status, "completed");
    assert.equal((await queryOperationRefs(index, { epoch: "one", start: 2600, end: 3000 })).length, 2);
    assert.equal((await queryOperationRefs(index, { epoch: "two", start: 2000, end: 3000 })).length, 0);
    assert.equal((await readdir(join(index.directory, "operations"))).some(name => name.startsWith("data-")), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(queryOperationRefs(index, { start: 0, end: 10000, signal: controller.signal }), { name: "AbortError" });
  } finally { index?.close(); await rm(path, { recursive: true, force: true }); }
});
