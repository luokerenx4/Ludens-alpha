import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogIndex } from "../lib/log-index";
import { captureSources, verifySources } from "../lib/cold-source";
import { createRunReducer } from "../lib/run-index";
import { createActivityReducer, activityBlocks } from "../lib/activity";
import { refreshOperationIndex, queryOperationRefs } from "../lib/operation-index";
import { eventObservations } from "../lib/observation-events";
import { aggregate } from "../lib/aggregate";
import { projectTelemetry } from "../lib/telemetry";
import { emptyLivePhase, advanceLivePhase } from "../lib/live-phase";
import type { Event } from "../lib/types";
const line = (event: Event) => JSON.stringify(event) + "\n";
function event(type: string, seq: number, ms: number, recordingId?: string, data: Record<string, unknown> = {}, trace: Record<string, string> = {}): Event {
  const at = new Date(ms).toISOString();
  return { serviceId: "service", type, seq, at, atMs: ms, data, trace: { ...(recordingId ? { recordingId } : {}), ...trace },
    origin: { eventId: `service:${seq}`, clockId: "service", seq, at, atMs: ms }, source: { component: "baseware" } };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-source-reader-"))), run = join(root, "run"), source = join(root, "device");
  await Promise.all([mkdir(run), mkdir(join(source, "events"), { recursive: true }), mkdir(join(source, "diagnostics"), { recursive: true })]);
  await writeFile(join(source, "source.json"), JSON.stringify({ sourceId: "service", format: "baseware-events-v1" }));
  const dependency = { sourceId: "service", format: "baseware-events-v1", root: source, recordingId: "run-A", windows: [{ afterSeq: 0, throughSeq: 3 }] };
  const manifest = () => writeFile(join(run, "manifest.json"), JSON.stringify({ eventSources: [dependency] }));
  await manifest();
  await writeFile(join(run, "events.jsonl"), line({ type: "control", seq: 1, at: new Date(1000).toISOString(), atMs: 1000, data: { mode: "auto" }, trace: { epoch: "A" } }));
  return { root, run, source, dependency, manifest, file: join(source, "events", "2026-10-27-1.jsonl") };
}

test("source pointers merge by time; late ownership and advancing background watermarks never duplicate", async () => {
  const f = await fixture(), index = new LogIndex(f.run, join(f.root, "index"));
  const trace = { epoch: "A", traceId: "trace", spanId: "action", operationId: "operation" };
  try {
    await writeFile(f.file, [event("action_start", 2, 2000, "run-A", { actionId: "jump" }, trace),
      event("command", 3, 3000, "run-B", { marker: "foreign" }),
      event("background_status", 4, 4000, undefined, { marker: "await-watermark" }),
      event("action_end", 5, 5000, "run-A", { actionId: "jump", status: "completed" }, trace)].map(line).join(""));
    const source = await captureSources(f.run); index.setSourceSnapshot(source.snapshot);
    await index.bulkEvents(); index.flush();
    assert.deepEqual((await index.queryEvents()).map(row => row.event.type), ["control", "action_start", "action_end"]);
    const raw = (await index.queryEventRefs({ actionId: "jump" }))[0];
    assert.equal(raw.file, f.file); assert.equal(raw.sourceId, "service"); await verifySources(f.run, source);
    await refreshOperationIndex(index);
    assert.equal((await queryOperationRefs(index, { epoch: "A", start: 0, end: 6000 }))[0].status, "completed");
    const generation = index.generation;
    index.setSourceSnapshot(undefined); f.dependency.windows[0].throughSeq = 5; await f.manifest();
    await index.refreshEvents(); assert.equal(index.generation, generation);
    assert.deepEqual((await index.queryEvents()).map(row => row.event.type), ["control", "action_start", "action_end", "background_status"]);
    await index.refreshEvents(); assert.equal(index.eventRevision, 4);
    await appendFile(f.file, line(event("execution", 6, 6000, "run-B", { marker: "still-foreign" })));
    await index.refreshEvents(); assert.equal(index.eventRevision, 4);
    await appendFile(f.file, line(event("execution", 7, 7000, "run-A", { marker: "late-owned" })));
    await index.refreshEvents(); assert.equal(index.eventRevision, 5);
    assert.equal((await index.queryEvents({ afterPosition: 4 }))[0].event.data.marker, "late-owned");
  } finally { index.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("full diagnostics are independent; old runs never discover sources; declared missing sources fail explicitly", async () => {
  const f = await fixture(), normal = new LogIndex(f.run, join(f.root, "normal")), full = new LogIndex(f.run, join(f.root, "full"), "diagnostics");
  try {
    await writeFile(f.file, line(event("device_sampling_stats", 1, 2000, "run-A", { calls: 30 })));
    await writeFile(join(f.source, "diagnostics", "2026-10-27-2.jsonl"), line(event("command", 2, 2100, "run-A", { readOnly: true })));
    await writeFile(join(f.run, "diagnostics.jsonl"), line({ ...event("python_call_start", 3, 2200, "run-A"), origin: undefined }));
    await normal.refreshEvents(); assert.deepEqual((await normal.queryEvents()).map(row => row.event.type), ["control", "device_sampling_stats"]);
    assert.ok(!Object.keys((await captureSources(f.run)).snapshot).some(name => name.includes("diagnostics")));
    await full.refreshEvents({ maxBytes: 4096 }); assert.deepEqual((await full.queryEvents()).map(row => row.event.type), ["command", "python_call_start"]);
    await writeFile(join(f.run, "manifest.json"), "{}"); const old = new LogIndex(f.run, join(f.root, "old"));
    try { await old.refreshEvents(); assert.equal(old.eventRevision, 1); } finally { old.close(); }
    await f.manifest(); await rm(f.source, { recursive: true }); await assert.rejects(normal.refreshEvents(), /unavailable/);
  } finally { normal.close(); full.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("merged observations retain requests and telemetry; stats and omitted parents create no pending or bubbles", async () => {
  const f = await fixture(), index = new LogIndex(f.run, join(f.root, "index"));
  const trace = { epoch: "A", traceId: "t", spanId: "read", operationId: "read-1", parentSpanId: "omitted-sample" };
  const command = event("command", 1, 1000, "run-A", { readOnly: true, controllerId: "screen", arguments: { native: true } }, trace);
  const execution = event("execution", 2, 2000, "run-A", { id: "capture", controllerId: "screen", readOnly: true,
    outcome: "success", status: "completed", exitCode: 0, stdout: "", observations: [{ id: "frame", mediaType: "image/png", timeline: { recordId: "record", sequence: 1, asset: "frame.png" } }] }, trace);
  const stats = event("device_sampling_stats", 3, 3000, "run-A", { calls: 3000 });
  const fault = event("device_sampling_error", 4, 4000, "run-A", { error: "device lost" });
  try {
    await writeFile(f.file, [command, execution, stats, fault].map(line).join(""));
    const capture = await captureSources(f.run); index.setSourceSnapshot(capture.snapshot); index.beginBulk();
    const reducer = await createRunReducer(index), activity = await createActivityReducer(index);
    await index.bulkEvents({ onEvent: async (event, position) => { await reducer.feed({ event, position }); await activity.feed({ event, position }); } });
    await reducer.finish(); await activity.finish(); index.finishBulk(); index.flush();
    assert.equal(eventObservations(execution)[0].id, "frame");
    const activeTrace = { epoch: "A", traceId: "t", spanId: "active-read" };
    const active = aggregate([event("capability_start", 8, 8000, "run-A", { id: "controller/screen", action: "call", arguments: { native: true } }, activeTrace),
      event("capability_end", 9, 9000, "run-A", { executionId: "capture-active", controllerId: "screen", observations: execution.data.observations }, activeTrace)]);
    assert.equal(active.observations[0].request?.controllerId, "controller/screen");
    assert.deepEqual(active.observations[0].request?.arguments, { native: true });
    const projected = aggregate([command, execution]);
    assert.equal(projected.observations[0].request?.controllerId, "screen");
    assert.deepEqual(projected.observations[0].request?.arguments, { native: true });
    const telemetry = projectTelemetry([command, execution, stats, fault]);
    assert.equal(telemetry.devices.outcomes.pending, 0); assert.equal(telemetry.devices.outcomes.success, 1);
    const phase = emptyLivePhase(); advanceLivePhase(phase, [stats, fault]); assert.deepEqual(phase.pending, {});
    const blocks = await activityBlocks(f.run, [command, execution, stats, fault]);
    assert.equal(blocks.find(block => block.title === "device_sampling_stats")?.kind, "diagnostic");
    assert.equal(blocks.filter(block => block.kind === "system").length, 1);
    assert.equal(blocks.find(block => block.title === "device_sampling_error")?.kind, "system");
    assert.equal(blocks.find(block => block.title === "device_sampling_error")?.id, "event:run:service:4");
    const mirrored = await activityBlocks(f.run, [{ ...fault, serviceId: undefined, seq: 42 }]);
    assert.equal(mirrored[0].id, "event:run:42", "old mirrored rows keep published activity identities");
    assert.equal([...index.store("run-observations").entries()].length, 1);
  } finally { index.close(); await rm(f.root, { recursive: true, force: true }); }
});
