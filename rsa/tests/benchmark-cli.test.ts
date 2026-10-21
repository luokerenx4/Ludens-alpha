import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverBenchmarks } from "../src/benchmark/catalog.ts";
import { runBenchmark, type RunOptions } from "../src/benchmark/runner.ts";
import { validateResult } from "../src/benchmark/contract.ts";
import { history } from "../src/benchmark/store.ts";

test("workspace catalog, CLI run/history/compare and the shared Python result contract agree", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-bench-cli-"));
  const workspace = join(root, "workspace"), artifactRoot = join(root, "index");
  await mkdir(join(workspace, "benchmarks"), { recursive: true });
  await writeFile(join(workspace, "benchmarks", "model.py"), `from rsa_tools import benchmark, current_benchmark
@benchmark(targets=["python/model.py:predict"])
def accuracy(value: int = 5):
    """Measure a deterministic value."""
    current_benchmark().conditions(dataset="fixed")
    return {"metrics": {"accuracy": {"value": value, "unit": "points", "direction": "higher"}}}
`);
  const runner = resolve(import.meta.dir, "../src/benchmark/runner.ts");
  const command = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "-e", `import { benchmarkCommand } from ${JSON.stringify(runner)}; await benchmarkCommand(${JSON.stringify(args)}, ${JSON.stringify(artifactRoot)}, ${JSON.stringify(workspace)});`],
      { cwd: root, env: { ...process.env, RSA_RUN_ID: "", RSA_SOCKET: "", RSA_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  };
  try {
    const listing = await command(["list"]);
    const definition = listing.benchmarks.find((item: any) => item.source === "workspace");
    expect(listing.benchmarks).toHaveLength(6);
    expect((await command(["help", definition.id])).parameters.properties.value.default).toBe(5);
    const first = await command(["run", definition.id]);
    const second = await command(["run", definition.id, "--args", '{"value":8}']);
    validateResult(first); validateResult(second);
    expect(first).toMatchObject({ status: "completed", verdict: null, parameters: { value: 5 } });
    expect(second.metrics[0].value).toBe(8);
    expect((await command(["history", definition.id])).results).toHaveLength(2);
    expect(await command(["compare", second.runId, first.runId])).toMatchObject({ compatible: false, changes: ["参数"], metrics: [{ delta: 3 }] });
    expect((await readFile(join(workspace, "logs", first.runId, "events.jsonl"), "utf8")).match(/"type":\s*"benchmark_start"/g)).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("supervised cancellation finalizes one Python run even with a partial event tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-bench-cancel-"));
  const workspace = join(root, "workspace"), artifactRoot = join(root, "index");
  await mkdir(workspace);
  await writeFile(join(workspace, "wait.py"), `import time
from pathlib import Path
from rsa_tools import benchmark, current_benchmark
@benchmark
def wait():
    """Wait for supervisor cancellation."""
    with (current_benchmark().run_dir / "events.jsonl").open("a") as stream:
        stream.write('{"seq":')
    Path("ready").touch()
    time.sleep(60)
`);
  const abort = new AbortController();
  const options: RunOptions = { workspace, artifactRoot, model: "unused", seconds: 10, maxRequests: 1, seed: 7, signal: abort.signal };
  try {
    const { benchmarks } = await discoverBenchmarks(workspace, artifactRoot);
    const pending = runBenchmark(benchmarks.find(item => item.source === "workspace")!, {}, options);
    const deadline = Date.now() + 4000;
    while (!await Bun.file(join(workspace, "ready")).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(join(workspace, "ready")).exists()).toBe(true);
    abort.abort();
    const { result, runDir } = await pending;
    expect(result).toMatchObject({ status: "cancelled", verdict: null });
    expect(result.endedAt).not.toBeNull();
    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toContain('{"seq":');
    const events = lines.filter(line => line !== '{"seq":').map(line => JSON.parse(line));
    expect(events.map(event => event.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1).type).toBe("benchmark_supervisor_end");
    expect((await history(workspace)).results).toHaveLength(1);
  } finally { abort.abort(); await rm(root, { recursive: true, force: true }); }
}, 10_000);

// Reconstructs the 2026-10-21 Mario Maker failure: the jump had already happened,
// but missing report fields caused successive real trials. A counter stands in
// for input so this regression never controls an emulator or calls a model.
test("report correction preserves one execution and pins revisions without importing the evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-bench-report-repair-"));
  const workspace = join(root, "workspace"), artifactRoot = join(root, "index");
  await mkdir(workspace);
  const evaluator = join(workspace, "jump.py");
  await writeFile(evaluator, `from pathlib import Path
from rsa_tools import benchmark
@benchmark(protocol="jump-v1")
def jump():
    """Measure one jump."""
    counter = Path("actions.txt")
    counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else "1")
    return {"metrics": {"height": {"value": 24}}, "checks": {"landed": {"passed": "yes"}}}
`);
  const runner = resolve(import.meta.dir, "../src/benchmark/runner.ts");
  const command = async (args: string[], expectedCode = 0) => {
    const child = Bun.spawn([process.execPath, "-e", `import { benchmarkCommand } from ${JSON.stringify(runner)}; await benchmarkCommand(${JSON.stringify(args)}, ${JSON.stringify(artifactRoot)}, ${JSON.stringify(workspace)});`],
      { env: { ...process.env, RSA_WORKSPACE: workspace, RSA_RUN_ID: "", RSA_SOCKET: "" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, err }).toEqual({ code: expectedCode, err: "" });
    return JSON.parse(out);
  };
  try {
    const first = await command(["run", "python/jump.py:jump"], 2);
    expect(first.status).toBe("completed"); expect(first.verdict).toBeNull();
    expect(first.report.outcome).toBeNull();
    expect(first.report.errors.map((error: any) => error.path)).toEqual(expect.arrayContaining(["/metrics/height", "/checks/landed/passed"]));
    expect(first.report.raw.metrics.height.value).toBe(24);
    const runDir = join(workspace, "logs", first.runId);
    const execution = await readFile(join(runDir, "benchmark.json"), "utf8");
    expect(JSON.parse(execution)).not.toHaveProperty("checks");
    expect(JSON.parse(execution)).not.toHaveProperty("verdict");
    expect(JSON.parse(await readFile(join(runDir, "reports", first.report.id + ".raw.json"), "utf8")).raw).toEqual(first.report.raw);
    // report/validate must still work even when the evaluator can no longer load.
    await writeFile(evaluator, "raise ImportError('must not run for report correction')\n");
    const report = { metrics: { height: { value: 24, unit: "px", direction: "higher" } },
      checks: { landed: { passed: true, expected: true, actual: true } } };
    const reportPath = join(workspace, "report.json");
    await writeFile(reportPath, JSON.stringify(report));
    expect((await command(["validate", "report.json"])).errors).toEqual([]);
    const corrected = await command(["report", first.runId, "--file", "report.json"]);
    expect(corrected).toMatchObject({ status: "completed", verdict: "passed", checks: [{ id: "landed", expected: true, actual: true, evidenceSeq: [] }] });
    expect(corrected.report.previousReportId).toBe(first.report.id);
    expect(corrected.reports).toHaveLength(2);
    expect(corrected.report.protocolVersion).toBe("jump-v1");
    report.metrics.height.value = 25;
    await writeFile(reportPath, JSON.stringify(report));
    const rescored = await command(["report", first.runId, "--file", "report.json", "--protocol", "jump-v2", "--reason", "updated scoring"]);
    const comparison = await command(["compare", `${first.runId}@${rescored.report.id}`, `${first.runId}@${corrected.report.id}`]);
    expect(comparison).toMatchObject({ sameExecution: true, compatible: false, changes: ["评测口径"], metrics: [{ baseline: 24, value: 25, delta: 1 }] });
    const reformatted = await command(["report", first.runId, "--file", "report.json"]);
    expect(reformatted.report.protocolVersion).toBe("jump-v2");
    expect(await readFile(join(runDir, "benchmark.json"), "utf8")).toBe(execution);
    expect(await readFile(join(workspace, "actions.txt"), "utf8")).toBe("1");
    expect((await command(["history"])).results).toHaveLength(1);
    expect(corrected.reports[0].outcome).toBeNull();
    const pinned = await command(["compare", `${first.runId}@${corrected.report.id}`, `${first.runId}@${corrected.report.id}`]);
    expect(pinned.metrics[0].value).toBe(24);
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "benchmark_end")).toHaveLength(1);
    expect(events.filter(event => event.type === "benchmark_report")).toHaveLength(4);
    expect(events.map(event => event.seq)).toEqual(events.map((_, i) => i + 1));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("CLI preserves the real load exception and report repair cannot turn it into completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsa-bench-load-error-"));
  const workspace = join(root, "workspace"), artifactRoot = join(root, "index");
  await mkdir(workspace);
  await writeFile(join(workspace, "broken.py"), `from rsa_tools import benchmark
from missing_action_module import pause_menu_visible
@benchmark
def evaluate():
    """Import a missing action before evaluation."""
    return {}
`);
  try {
    const { benchmarks } = await discoverBenchmarks(workspace, artifactRoot);
    const { result, runDir } = await runBenchmark(benchmarks.find(item => item.source === "workspace")!, {},
      { workspace, artifactRoot, model: "unused", seconds: 5, maxRequests: 1, seed: 7 });
    expect(result).toMatchObject({ status: "error", errorPhase: "load", report: null });
    expect(result.error).toContain("ModuleNotFoundError");
    expect(result.error).toContain("missing_action_module");
    const { saveReport, readResult } = await import("../src/benchmark/store.ts");
    await saveReport(runDir, result, { checks: { repaired: { passed: true } } });
    expect(await readResult(workspace, result.runId)).toMatchObject({ status: "error", errorPhase: "load", verdict: null });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);
