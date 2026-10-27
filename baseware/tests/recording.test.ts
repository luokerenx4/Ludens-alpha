import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasewareCore } from "../src/core.ts";
import { EventLog } from "../src/events.ts";
import { SamplingStats } from "../src/sampling-stats.ts";
import { listEventSourceFiles, matchesSourceEvent, readRunEvents, type SourceDependency } from "../../shared/event-sources.ts";
import type { ControllerContext, ToolExecutionResult } from "../src/contracts.ts";
import type { DeviceEvent, Trace } from "../src/protocol.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const trace: Trace = { recordingId: "run-a", recordingPurpose: "continuous-perception", traceId: "trace", spanId: "sample" };
const native: ToolExecutionResult = { id: "sample", result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
  observations: [{ id: "image", controllerId: "camera", data: "AAAA", mediaType: "image/png", timing: { clock: "fake", requestedAtMs: 1, receivedAtMs: 2 } }],
  status: "completed", exitCode: 0, stdout: "", stderr: "", timing: { clock: "fake", requestedAtMs: 1, receivedAtMs: 2 } };

function fixture(options: { diagnostics?: "normal" | "full"; execute?: (context: ControllerContext) => Promise<ToolExecutionResult> } = {}) {
  const events: DeviceEvent[] = [];
  const core = new BasewareCore({ drivers: [], diagnostics: options.diagnostics,
    capabilities: { controllers: [{ tool: { name: "camera", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
      requiresControl: false, execute: (_, context) => options.execute?.(context) ?? Promise.resolve(native) }] },
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, ...metadata! } as DeviceEvent) });
  cleanups.push(() => core.close());
  return { core, events };
}

test("normal reads keep native media and only bounded interval statistics at 1, 10 and 30 Hz", async () => {
  for (const hz of [1, 10, 30]) {
    const { core, events } = fixture();
    for (let sample = 0; sample < hz * 30 * 2; sample++) {
      expect(await core.execute("camera", {}, undefined, signal(), trace)).toBe(native);
    }
    expect(events).toHaveLength(0);
    await core.close();
    expect(events.map(event => event.type)).toEqual(["device_sampling_stats"]);
    expect(events[0]!.data).toMatchObject({ controllers: [{ controllerId: "camera", calls: hz * 30 * 2, errors: 0 }] });
    expect(JSON.stringify(events)).not.toContain("AAAA");
  }
  const { core, events } = fixture();
  await core.execute("camera", {}, undefined, signal(), { recordingId: "active-reader" });
  expect(events).toHaveLength(0); // Direct Baseware read returns its result, too; its caller owns intent logging.
});

test("full adds diagnostic reads without changing the normal contract or duplicating facts", async () => {
  const normal = fixture(), full = fixture({ diagnostics: "full" });
  expect(await normal.core.execute("camera", {}, undefined, signal(), trace))
    .toEqual(await full.core.execute("camera", {}, undefined, signal(), trace));
  expect(normal.events).toHaveLength(0);
  expect(full.events.map(event => [event.type, event.channel])).toEqual([["command", "diagnostic"], ["execution", "diagnostic"]]);
  expect((full.events[1]!.data as any).observations).toMatchObject([{ id: "image", controllerId: "camera" }]);
  expect(JSON.stringify(full.events)).not.toContain("AAAA");
});

test("event projections omit only provably derived text; native RPC fields are untouched", async () => {
  const returned: ToolExecutionResult = { ...native, result: { content: [{ type: "text", text: "42" }] }, stdout: "42", stderr: "independent warning" };
  const { core, events } = fixture({ diagnostics: "full", execute: async () => returned });
  expect(await core.execute("camera", {}, undefined, signal())).toBe(returned);
  const execution = events.find(event => event.type === "execution")!.data as any;
  expect(execution.stdout).toBeUndefined();
  expect(execution.stderr).toBe("independent warning");
  expect(execution.result.content[0].text).toBe("42");
  expect(returned.stdout).toBe("42");
});

test("sample failures are immediate intervals, not one error per call; active failures stay individual", async () => {
  const { core, events } = fixture({ execute: async () => { throw new TypeError("camera unavailable"); } });
  for (let i = 0; i < 100; i++) await expect(core.execute("camera", {}, undefined, signal(), trace)).rejects.toThrow("unavailable");
  expect(events.map(event => event.type)).toEqual(["device_sampling_error"]);
  await expect(core.execute("camera", {}, undefined, signal(), { recordingId: "run-a" })).rejects.toThrow("unavailable");
  expect(events.at(-1)!.type).toBe("execution_error");
  await core.close();
  expect((events.find(event => event.type === "device_sampling_stats")!.data as any).controllers[0]).toMatchObject({ calls: 101, errors: 101 });
});

test("fault jitter stays one interval, separates recordings and recovers after a clear window", () => {
  let now = 0;
  const events: { type: string; data: any; trace: Trace }[] = [];
  const stats = new SamplingStats((type, data, trace = {}) => events.push({ type, data, trace }), () => now);
  for (let i = 0; i < 60; i++) {
    now = i * 100;
    stats.observe("camera", trace, 5, new TypeError(`frame ${i} unavailable`));
    stats.observe("camera", trace, 6);
  }
  stats.observe("camera", { ...trace, recordingId: "run-b" }, 7, new TypeError("other camera"));
  stats.flush();
  expect(events.filter(event => event.type === "device_sampling_error")).toHaveLength(2);
  expect(events.filter(event => event.type === "device_sampling_recovered")).toHaveLength(0);
  now = 11_000;
  stats.observe("camera", trace, 3);
  stats.flush();
  const recovery = events.filter(event => event.type === "device_sampling_recovered");
  expect(recovery).toHaveLength(1);
  expect(recovery[0]).toMatchObject({ trace: { recordingId: "run-a" }, data: { count: 60, reason: "recovered" } });
  stats.flush(true);
  expect(events.at(-1)).toMatchObject({ trace: { recordingId: "run-b" }, data: { reason: "stopped" } });
});

test("sampling cannot hide side effects, control provenance or late action completions", async () => {
  const events: DeviceEvent[] = [];
  let callback: ControllerContext["record"];
  const core = new BasewareCore({ drivers: [], capabilities: { controllers: [{ tool: { name: "motor", inputSchema: { type: "object" } },
    requiresControl: true, execute: async (_, context) => {
      callback = context.record;
      callback!("action_start", { actionId: "moving", inputs: [{ left: 500 }, { jump: 300 }] });
      return { ...native, result: { content: [] }, observations: [], actionId: "moving" };
    } }] }, record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, ...metadata! } as DeviceEvent) });
  cleanups.push(() => core.close());
  await core.handle({ kind: "acquire", epoch: "a", seconds: 30, trace: { recordingId: "run-a" } }, { id: "owner-a" });
  await core.execute("motor", {}, "a", signal(), trace);
  await core.release("a", "human");
  await core.handle({ kind: "acquire", epoch: "b", seconds: 30, trace: { recordingId: "run-b" } }, { id: "owner-b" });
  callback!("action_end", { actionId: "moving", status: "interrupted" });
  expect(events.filter(event => ["command", "action_start", "execution", "action_end"].includes(event.type)).map(event => [event.type, event.channel, event.trace.recordingId, event.trace.parentOmitted]))
    .toEqual([["command", undefined, "run-a", true], ["action_start", undefined, "run-a", true], ["execution", undefined, "run-a", true], ["action_end", undefined, "run-a", true]]);
  expect(events.filter(event => event.type === "baseware_control").map(event => event.trace.recordingId)).toEqual(["run-a", "run-a", "run-b"]);
  expect(events.at(-1)!.trace).toMatchObject({ recordingId: "run-a", epoch: "a" });
});

test("storage and subscriber failure never retry input or block human release; lost IDs stay monotonic", async () => {
  let fail = true, inputs = 0, releases = 0;
  const notifications: DeviceEvent[] = [], stored: DeviceEvent[] = [];
  const core = new BasewareCore({ drivers: [], capabilities: { controllers: [{ tool: { name: "motor", inputSchema: { type: "object" } },
    requiresControl: true, release: async () => { releases++; }, execute: async () => { inputs++; return native; } }] },
    record: (type, data, trace = {}, metadata) => { if (fail) throw new Error("disk full"); stored.push({ type, data, trace, ...metadata! } as DeviceEvent); } });
  cleanups.push(() => core.close());
  await core.handle({ kind: "subscribe" }, { id: "broken", onEvent() { throw new Error("gone"); } });
  await core.handle({ kind: "subscribe" }, { id: "watcher", onEvent: event => notifications.push(event) });
  await core.acquire("a", 30, { id: "owner" });
  expect(await core.execute("motor", {}, "a", signal())).toBe(native);
  expect(await core.release("a", "human")).toMatchObject({ mode: "manual", storageError: { count: 4 } });
  expect([inputs, releases]).toEqual([1, 1]);
  expect(notifications.map(event => event.origin.seq)).toEqual([1, 2, 3, 4]);
  expect(notifications.every(event => event.persisted === false)).toBe(true);
  fail = false;
  core.record("service_end", {});
  expect(stored.map(event => [event.type, event.origin.seq])).toEqual([["service_end", 5], ["event_storage_gap", 6]]);
  expect(stored[1]!.data).toMatchObject({ firstSeq: 1, lastSeq: 4, count: 4 });
  expect(core.status()).toMatchObject({ seq: 6, storageError: null });
});

test("segmented source readers retain only recorded ownership or confirmed background windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-sources-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = new EventLog(directory, "device", { segmentBytes: 500, segmentSeconds: 3600 });
  let seq = 0;
  function record(recordingId?: string, channel?: "diagnostic", at = "2026-10-27T00:00:00.000Z") {
    log.record("fact", { payload: "x".repeat(120) }, recordingId ? { recordingId } : {}, {
      source: { component: "baseware" }, origin: { clockId: "device", eventId: `device:${++seq}`, seq, at, atMs: seq }, channel });
  }
  record(); record("run-a"); record("run-b"); record("run-a", "diagnostic"); record("run-a", undefined, "2026-10-27T01:00:00.000Z");
  const dependency: SourceDependency = { ...log.source, recordingId: "run-a", windows: [{ afterSeq: 0, throughSeq: 1 }] };
  const files = await listEventSourceFiles(dependency);
  const read = async (entries = files) => (await Promise.all(entries.map(file => readFile(file.path, "utf8")))).join("").trim().split("\n").map(line => JSON.parse(line));
  const events = await read();
  expect(events.filter(event => matchesSourceEvent(event, dependency)).map(event => event.seq)).toEqual([1, 2, 5]);
  expect(files.every(file => file.channel === "events" && file.size > 0)).toBe(true);
  expect((await listEventSourceFiles(dependency, "diagnostics"))).toHaveLength(1);
  expect((await readdir(join(log.source.root, "events"))).filter(name => name.endsWith(".jsonl"))).toHaveLength(4);
  expect(matchesSourceEvent({ serviceId: "device", seq: 1 }, { ...dependency, windows: [{ afterSeq: 0 }] })).toBe(false);
  expect(matchesSourceEvent({ serviceId: "other-device", seq: 2, trace: { recordingId: "run-a" } }, dependency)).toBe(false);
  // A crash can leave an appended line newer than the segment summary; never skip it using stale metadata.
  const all = (await readdir(join(log.source.root, "events"))).filter(name => name.endsWith(".jsonl")).sort();
  const third = join(log.source.root, "events", all[2]!);
  await appendFile(third, JSON.stringify({ serviceId: "device", seq: 6, trace: { recordingId: "run-a" }, type: "late" }) + "\n");
  const expanded = await listEventSourceFiles(dependency);
  expect(expanded.some(file => file.path === third)).toBe(true);
  expect((await read(expanded)).filter(event => matchesSourceEvent(event, dependency)).map(event => event.seq)).toEqual([1, 2, 6, 5]);
  // Local and device events are read once at their original identities, diagnostics only on demand.
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ eventSources: [dependency, dependency] }));
  await writeFile(join(directory, "events.jsonl"), JSON.stringify({ at: "2026-10-27T00:30:00.000Z", seq: 1, type: "local" }) + "\n{\"partial\":");
  const merged = await Array.fromAsync(readRunEvents(directory));
  expect(merged.filter(event => event.type === "fact")).toHaveLength(3);
  expect(merged.filter(event => event.type === "local")).toHaveLength(1);
  expect(merged.findIndex(event => event.type === "local")).toBeLessThan(merged.findIndex(event => event.seq === 5));
  expect((await Array.fromAsync(readRunEvents(directory, { channel: "diagnostics" }))).map(event => event.seq)).toEqual([4]);
  await rm(join(log.source.root, "source.json"));
  await expect(listEventSourceFiles(dependency)).rejects.toMatchObject({ code: "EVENT_SOURCE_UNAVAILABLE" });
});

test("a storage failure seals an uncertain tail before any later facts are appended", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-tail-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = new EventLog(directory, "device");
  const record = (seq: number) => log.record("fact", { seq }, { recordingId: "run" }, {
    source: { component: "baseware" }, origin: { clockId: "device", eventId: `device:${seq}`, seq, at: "2026-10-27T00:00:00.000Z", atMs: seq } });
  record(1);
  const first = (await readdir(join(log.source.root, "events"))).find(name => name.endsWith(".jsonl"))!;
  const meta = join(log.source.root, "events", first.replace(/\.jsonl$/, ".meta.json"));
  await rm(meta); await mkdir(meta); // Make the atomic summary rename fail after the append.
  expect(() => record(2)).toThrow();
  await rm(meta, { recursive: true });
  await appendFile(join(log.source.root, "events", first), '{"partial":');
  record(3);
  expect((await readdir(join(log.source.root, "events"))).filter(name => name.endsWith(".jsonl"))).toHaveLength(2);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ eventSources: [{ ...log.source, recordingId: "run", windows: [] }] }));
  expect((await Array.fromAsync(readRunEvents(directory))).map(event => event.seq)).toEqual([1, 2, 3]);
});

test("source reads can be cancelled while scanning only foreign recording events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-reader-cancel-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = new EventLog(directory, "device");
  log.record("fact", {}, { recordingId: "run-a" }, {
    source: { component: "baseware" }, origin: { clockId: "device", eventId: "device:1", seq: 1,
      at: "2026-10-27T00:00:00.000Z", atMs: 1 } });
  const segment = (await readdir(join(log.source.root, "events"))).find(name => name.endsWith(".jsonl"))!;
  const foreign = JSON.stringify({ serviceId: "device", seq: 2, trace: { recordingId: "run-b" }, payload: "x".repeat(400) }) + "\n";
  await appendFile(join(log.source.root, "events", segment), foreign.repeat(20_000));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ eventSources: [{ ...log.source, recordingId: "run-a", windows: [] }] }));
  const controller = new AbortController();
  const events = readRunEvents(directory, { signal: controller.signal });
  expect((await events.next()).value?.trace.recordingId).toBe("run-a");
  const pending = events.next();
  const timer = setTimeout(() => controller.abort(), 1);
  try { await expect(pending).rejects.toMatchObject({ name: "AbortError" }); }
  finally { clearTimeout(timer); await events.return(undefined); }
});
