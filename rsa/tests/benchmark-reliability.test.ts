import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthorReport } from "../src/benchmark/types.ts";
import { validateAuthorReport } from "../src/benchmark/report.ts";

// Each benchmark owns its transport globals, matching the production benchmark runner.
test.each([
  ["control-handoff", ["control", "capability_start", "execution", "python_capability_result"]],
  ["ws-recovery", ["model_start", "model_ws_dispatch", "model_http_start", "model_end"]],
  ["background-compaction", ["compaction_speculation", "compaction_http_start", "compaction_http_end", "auto_compaction_end"]],
  ["perception-lifecycle", ["perception_status", "perception_observe_start", "perception_observe_end"]],
] as const)("%s evaluates real production events without network or devices", async (id, requiredEvents) => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-benchmark-test-"));
  const runDir = join(directory, "logs/run"), workspace = join(directory, "workspace");
  const source = `import { run } from ${JSON.stringify(resolve(import.meta.dir, `../src/benchmark/cases/${id}.ts`))};
import { EventLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/events.ts"))};
const log = new EventLog(${JSON.stringify(runDir)}, {id: "offline-benchmark", now: () => performance.now()});
const result = await run({runDir: ${JSON.stringify(runDir)}, workspace: ${JSON.stringify(workspace)}, log, metadata: {}, model: "openai-codex/gpt-6.1-sol", seconds: 30, maxRequests: 10, seed: 7});
await Bun.write(${JSON.stringify(join(directory, "outcome.json"))}, JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "-e", source], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const result: AuthorReport = JSON.parse(await readFile(join(directory, "outcome.json"), "utf8"));
    expect(validateAuthorReport(result).errors).toEqual([]);
    expect(Object.keys(result.checks!).length).toBeGreaterThanOrEqual(4);
    expect(Object.values(result.checks!).filter(check => check.passed !== true)).toEqual([]);
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const type of requiredEvents) expect(events.some(event => event.type === type)).toBe(true);
    const sequences = new Set(events.map(event => event.seq));
    for (const check of Object.values(result.checks!)) {
      expect(check.evidenceSeq!.length).toBeGreaterThan(0);
      expect(check.evidenceSeq!.every(seq => sequences.has(seq))).toBe(true);
    }
    expect(Object.values(result.metrics!).some(metric => metric.value !== null)).toBe(true);
    expect(Object.values(result.metrics!).every(metric => metric.value === null || Number.isFinite(metric.value))).toBe(true);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test.each(["control-handoff", "ws-recovery", "background-compaction"])("%s cancellation cleans up before returning", async id => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-benchmark-abort-"));
  const runDir = join(directory, "logs/run"), workspace = join(directory, "workspace");
  const source = `import { run } from ${JSON.stringify(resolve(import.meta.dir, `../src/benchmark/cases/${id}.ts`))};
import { EventLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/events.ts"))};
const control = new AbortController(), beforeFetch = globalThis.fetch, beforeSocket = globalThis.WebSocket;
const log = new EventLog(${JSON.stringify(runDir)}, {id: "cancel-benchmark", now: () => performance.now()});
const record = log.record;
let commands = 0, fired = false, caught = "";
Object.defineProperty(log, "record", {value: (type, data, trace, metadata) => {
  record(type, data, trace, metadata);
  if (type === "command") commands++;
  const trigger = ${JSON.stringify(id)} === "control-handoff" ? type === "command" && commands === 2
    : ${JSON.stringify(id)} === "ws-recovery" ? type === "benchmark_transport_step" : type === "compaction_http_end";
  if (trigger && !fired) { fired = true; queueMicrotask(() => control.abort(new Error("benchmark cancelled"))); }
}});
try { await run({runDir: ${JSON.stringify(runDir)}, workspace: ${JSON.stringify(workspace)}, log, metadata: {}, model: "openai-codex/gpt-6.1-sol", seconds: 30, maxRequests: 10, seed: 7, signal: control.signal}); }
catch (error) { caught = String(error); }
let pythonGone = true;
const pidFile = Bun.file(${JSON.stringify(join(workspace, "handoff-python.pid"))});
if (await pidFile.exists()) { const pid = Number(await pidFile.text()); try { process.kill(pid, 0); pythonGone = false; } catch {} }
await Bun.write(${JSON.stringify(join(directory, "cancel.json"))}, JSON.stringify({fired, caught, pythonGone, restored: globalThis.fetch === beforeFetch && globalThis.WebSocket === beforeSocket}));`;
  const child = Bun.spawn([process.execPath, "-e", source], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(join(directory, "cancel.json"), "utf8"))).toEqual({
      fired: true, caught: "Error: benchmark cancelled", pythonGone: true, restored: true,
    });
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); }
}, 10_000);
