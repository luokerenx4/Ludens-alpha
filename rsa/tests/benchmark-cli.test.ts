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
    return {"metrics": [{"id": "accuracy", "value": value, "unit": "points", "direction": "higher"}]}
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
}, 15_000);

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
  const options: RunOptions = { workspace, artifactRoot, live: false, model: "unused", seconds: 10, maxRequests: 1, seed: 7, signal: abort.signal };
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
