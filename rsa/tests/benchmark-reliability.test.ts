import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readEvents } from "../src/benchmark/fixtures/evidence.ts";

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
const result = await run({runDir: ${JSON.stringify(runDir)}, workspace: ${JSON.stringify(workspace)}, log, metadata: {}, model: "openai-codex/gpt-6.1-sol", seconds: 30, maxRequests: 10, seed: 7, budget: {deadlineMs: Date.now() + 30_000, signal: new AbortController().signal}});
await Bun.write(${JSON.stringify(join(directory, "outcome.json"))}, JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "-e", source], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const measurements = JSON.parse(await readFile(join(directory, "outcome.json"), "utf8"));
    const { verify } = await import(`../benchmarks/tasks/${id}/tests/verify.ts`);
    const result = verify(measurements);
    const checks = Array.isArray(result.details) ? result.details.flatMap((d: any) => Object.values(d.checks)) : Object.values(result.details.checks);
    expect(checks.length).toBeGreaterThanOrEqual(4);
    expect(checks.filter((passed: unknown) => passed !== true)).toEqual([]);
    const events = await readEvents(runDir);
    for (const type of requiredEvents) expect(events.some(event => event.type === type)).toBe(true);
    expect(Object.keys(result.rewards).length).toBeGreaterThanOrEqual(6);
    expect(Object.values(result.rewards).every(value => typeof value === "number" && Number.isFinite(value))).toBe(true);
    // The same packaged entry is usable after pinning, with only native-profile
    // environment paths. It cannot rerun the case and needs no live socket.
    const artifacts = join(runDir, "artifacts"), verifierDir = join(directory, "verification");
    await mkdir(artifacts, { recursive: true }); await mkdir(verifierDir);
    await writeFile(join(artifacts, "measurements.json"), JSON.stringify(measurements));
    await writeFile(join(directory, "input.json"), "{}");
    const taskDir = resolve(import.meta.dir, `../benchmarks/tasks/${id}`);
    const verifier = Bun.spawn(["sh", join(taskDir, "tests/test.sh")], { cwd: directory,
      env: { PATH: process.env.PATH, RSA_BENCH_TASK_DIR: taskDir, RSA_BENCH_INPUT: join(directory, "input.json"),
        RSA_BENCH_ARTIFACTS: artifacts, RSA_BENCH_VERIFIER_DIR: verifierDir }, stdout: "pipe", stderr: "pipe" });
    expect({ code: await verifier.exited, stderr: await new Response(verifier.stderr).text() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(join(verifierDir, "reward.json"), "utf8"))).toEqual(result.rewards);
    // Verifier consumes frozen measurements; changing a decision input changes
    // its reward without invoking the production scenario again.
    if (id === "control-handoff") {
      const changed = structuredClone(measurements); changed.measurements[0].neutral = false;
      expect(verify(changed).rewards[changed.measurements[0].scenario + "-interrupted"]).toBe(0);
    }

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
let fired = false, caught = "";
Object.defineProperty(log, "record", {value: (type, data, trace, metadata) => {
  record(type, data, trace, metadata);
  const trigger = ${JSON.stringify(id)} === "control-handoff" ? type === "benchmark_handoff_requested" && data.scenario === "nested-python"
    : ${JSON.stringify(id)} === "ws-recovery" ? type === "benchmark_transport_step" : type === "compaction_http_end";
  if (trigger && !fired) { fired = true; queueMicrotask(() => control.abort(new Error("benchmark cancelled"))); }
}});
try { await run({runDir: ${JSON.stringify(runDir)}, workspace: ${JSON.stringify(workspace)}, log, metadata: {}, model: "openai-codex/gpt-6.1-sol", seconds: 30, maxRequests: 10, seed: 7, signal: control.signal, budget: {deadlineMs: Date.now() + 30_000, signal: new AbortController().signal}}); }
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
