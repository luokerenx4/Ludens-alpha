import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonModulePaths } from "../src/harness/python-capabilities.ts";
import { resolveWorkspaceState } from "../src/harness/workspace-state.ts";
import { validateResult, type BenchmarkDefinition, type BenchmarkResult } from "../src/benchmark/contract.ts";

const bridgePath = fileURLToPath(new URL("../python/rsa_tools/_bridge.py", import.meta.url));
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-python-benchmark-")));
  const workspace = join(root, "workspace"), artifactRoot = join(root, "index");
  await mkdir(workspace);
  return { root, workspace, artifactRoot };
}
function environment(workspace: string, artifactRoot: string) {
  return { ...process.env, RSA_WORKSPACE: workspace, RSA_ARTIFACT_ROOT: artifactRoot,
    RSA_SOCKET: "", RSA_RUN_ID: "", BASEWARE_TRACE: "{}", BASEWARE_EPOCH: "",
    PYTHONPATH: pythonModulePaths().join(delimiter) };
}
async function python(workspace: string, artifactRoot: string, code: string, overrides: Record<string, string> = {}) {
  const child = Bun.spawn(["python3", "-B", "-c", code], {
    cwd: workspace, env: { ...environment(workspace, artifactRoot), ...overrides }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout);
}
async function bridge(workspace: string, artifactRoot: string, input: unknown) {
  const child = Bun.spawn(["python3", "-B", bridgePath], {
    cwd: workspace, env: environment(workspace, artifactRoot), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { reply: JSON.parse(stdout), stderr, exitCode };
}
async function results(workspace: string) {
  const entries = await readdir(join(workspace, "logs"), { withFileTypes: true });
  return Promise.all(entries.filter(item => item.isDirectory()).map(async item => {
    const directory = join(workspace, "logs", item.name);
    const result = JSON.parse(await readFile(join(directory, "benchmark.json"), "utf8")) as BenchmarkResult;
    validateResult(result);
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    return { result, events, directory };
  }));
}

test("benchmark discovery is static, workspace-wide, indexed, and separate from capabilities", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await mkdir(join(workspace, "evaluations"));
    await writeFile(join(workspace, "evaluations", "quality.py"), `from pathlib import Path
from rsa_tools import benchmark as bench, capability
import rsa_tools as rsa
Path("imported").touch()
@bench(targets=["python/model.py:predict"], title="Quality")
def quality(seed: int = 7, weights: str | None = None):
    """Measure the current model."""
    return {}
@rsa.benchmark(mode="live")
def online():
    """Evaluate an explicitly requested online service."""
    return None
@capability
def predict(value: int):
    """An atomic capability."""
    return value
@bench(targets=compute_targets())
def dynamic():
    """Invalid metadata."""
@bench
def invalid(model):
    """Native objects belong in ordinary helpers."""
`);
    const found = await bridge(workspace, artifactRoot, { action: "discover_benchmarks", workspace });
    expect(found.exitCode).toBe(0);
    expect(found.reply.benchmarks.map((item: BenchmarkDefinition) => item.id)).toEqual([
      "python/evaluations/quality.py:quality", "python/evaluations/quality.py:online",
    ]);
    expect(found.reply.benchmarks[0]).toMatchObject({ title: "Quality", source: "workspace", mode: "offline",
      targets: ["python/model.py:predict"], parameters: { properties: { seed: { type: "integer", default: 7 } } } });
    expect(found.reply.benchmarks[0].revision).toBe(found.reply.benchmarks[0].entry.codeSHA);
    expect(found.reply.diagnostics).toHaveLength(2);
    expect(await Bun.file(join(workspace, "imported")).exists()).toBe(false);
    const capabilities = await bridge(workspace, artifactRoot, { action: "discover", workspace });
    expect(capabilities.reply.capabilities.map((item: any) => item.origin.function)).toEqual(["predict"]);
    const state = await resolveWorkspaceState(workspace, artifactRoot);
    expect(JSON.parse(await readFile(join(state.dir, "workspace.json"), "utf8"))).toEqual({ workspace });
    expect(JSON.parse(await readFile(join(workspace, "logs", "benchmarks-catalog.json"), "utf8"))).toEqual(found.reply);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct imports and SDK runs reuse models, persist parameterized reports offline, and keep host traces", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    const source = `from rsa_tools import benchmark, capability, current_benchmark
from rsa_tools._context import current
MODEL = object()
seen = []
@capability
def evaluate():
    """Evaluate the current model without reloading it."""
    seen.append((MODEL, current()["run_id"], dict(current()["trace"])))
    return len(seen)
@benchmark(targets=["python/model.py:evaluate"], title="Stable")
def quality(seed: int = 7, *, samples: int = 3):
    """Measure the currently loaded model."""
    context = current_benchmark()
    context.conditions(seed=seed, samples=samples)
    context.subject("weights", revision="training-step-10")
    artifact = context.run_dir / "scores.txt"
    artifact.write_text("scores")
    context.artifact(artifact, label="Scores")
    return {"metrics": [{"id": "count", "value": evaluate(), "unit": "calls"}]}
`;
    await writeFile(join(workspace, "model.py"), source);
    const response = await python(workspace, artifactRoot, `import hashlib, json
from pathlib import Path
from rsa_tools import Client
from rsa_tools.benchmarks import run
import model
loaded_hash = hashlib.sha256(Path("model.py").read_bytes()).hexdigest()
identity = model.MODEL
first = model.quality(11)
Path("model.py").write_text(Path("model.py").read_text().replace('title="Stable"', 'title="Edited"'))
second = run("python/model.py:quality", {"seed": 12, "samples": 5})
assert all(item[0] is identity for item in model.seen)
try:
    Client().call("python/model.py:quality")
except ValueError as error:
    assert "@capability" in str(error)
else:
    raise AssertionError("benchmark leaked into Controller capabilities")
print(json.dumps({"values": [first["metrics"][0]["value"], second["metrics"][0]["value"]],
                  "loaded_hash": loaded_hash, "host_ids": [item[1] for item in model.seen],
                  "traces": [item[2] for item in model.seen]}))
`, { RSA_RUN_ID: "host-run", BASEWARE_TRACE: JSON.stringify({ traceId: "parent-trace", spanId: "parent-span" }) });
    expect(response.values).toEqual([1, 2]);
    expect(response.host_ids).toEqual(["host-run", "host-run"]);
    const runs = (await results(workspace)).sort((a, b) => (a.result.parameters.seed as number) - (b.result.parameters.seed as number));
    expect(runs).toHaveLength(2);
    for (const { result, events, directory } of runs) {
      expect(result).toMatchObject({ status: "completed", verdict: null, parentRunId: "host-run",
        definition: { title: "Stable", revision: response.loaded_hash },
        subjects: [{ id: "weights", revision: "training-step-10" }, { id: "python/model.py:evaluate", revision: response.loaded_hash }],
        artifacts: [{ path: "scores.txt", label: "Scores" }],
        trace: { traceId: "parent-trace", parentSpanId: "parent-span" } });
      expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1);
      expect(events.filter(event => event.type === "benchmark_end")).toHaveLength(1);
      expect(events.map(event => event.type)).toEqual(["benchmark_start", "python_call_start", "python_call_end", "benchmark_end"]);
      expect(events[1].trace.parentSpanId).toBe(result.trace.spanId);
      expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ kind: "benchmark", runId: result.runId, workspaceId: result.project,
        parentRunId: "host-run", trace: result.trace, drivers: [], model: null, seconds: 0, maxRequests: 0,
        benchmark: { id: result.definition.id, revision: result.definition.revision } });
    }
    expect(runs.map(item => item.result.parameters)).toEqual([{ seed: 11, samples: 3 }, { seed: 12, samples: 5 }]);
    const catalog = JSON.parse(await readFile(join(workspace, "logs", "benchmarks-catalog.json"), "utf8"));
    expect(catalog.benchmarks[0].title).toBe("Edited");
    expect(catalog.benchmarks[0].revision).not.toBe(response.loaded_hash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark exceptions preserve Python semantics and cancellation cannot become a verdict", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await writeFile(join(workspace, "evaluation.py"), `from rsa_tools import benchmark, current_benchmark
@benchmark
def fail(kind: str):
    """Exercise incomplete evaluation."""
    current_benchmark().conditions(stage="registered")
    if kind == "cancel":
        raise KeyboardInterrupt("stop")
    if kind == "nan":
        return {"metrics": [{"id": "bad", "value": float("nan"), "unit": "ratio"}]}
    raise LookupError("original failure")
@benchmark
def no_checks():
    """Record an observation without claiming success."""
    return None
`);
    expect(await python(workspace, artifactRoot, `import json
import evaluation
seen = []
for kind in ["error", "cancel", "nan"]:
    try:
        evaluation.fail(kind)
    except BaseException as error:
        seen.append(type(error).__name__)
assert evaluation.no_checks() is None
print(json.dumps(seen))
`)).toEqual(["LookupError", "KeyboardInterrupt", "ValueError"]);
    const runs = await results(workspace);
    expect(runs).toHaveLength(4);
    const byKind = new Map(runs.map(run => [run.result.parameters.kind, run.result]));
    expect(byKind.get("error")).toMatchObject({ status: "error", verdict: null, error: "LookupError: original failure",
      conditions: { stage: "registered" } });
    expect(byKind.get("cancel")).toMatchObject({ status: "cancelled", verdict: null });
    expect(byKind.get("nan")).toMatchObject({ status: "error", verdict: null });
    expect(byKind.get(undefined)).toMatchObject({ status: "completed", verdict: null, checks: [], metrics: [] });
    for (const { result, events } of runs) {
      expect(result.endedAt).not.toBeNull();
      expect(events.at(-1).type).toBe("benchmark_end");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("JSON bridge adopts the reserved run once and captures incidental prints", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await mkdir(join(workspace, "benchmarks"));
    await writeFile(join(workspace, "benchmarks", "quality.py"), `from rsa_tools import benchmark
@benchmark
def score(value: int = 2):
    """Measure a parameter."""
    print("native diagnostic")
    return {"metrics": [{"id": "score", "value": value, "unit": "points"}]}
`);
    const discovery = await bridge(workspace, artifactRoot, { action: "discover_benchmarks", workspace });
    const definition: BenchmarkDefinition = discovery.reply.benchmarks[0];
    const state = await resolveWorkspaceState(workspace, artifactRoot);
    const runDir = join(workspace, "logs", "reserved");
    await mkdir(runDir);
    const initial: BenchmarkResult = { schemaVersion: 2, definition, status: "running", verdict: null,
      startedAt: new Date().toISOString(), endedAt: null, durationMs: null, runId: "reserved", project: state.id,
      workspace, trace: { traceId: "cli-trace", spanId: "cli-span" }, parameters: { value: 9 }, provenance: {},
      checks: [], metrics: [] };
    await writeFile(join(runDir, "benchmark.json"), JSON.stringify(initial));
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId: "reserved" }));
    const executed = await bridge(workspace, artifactRoot, { action: "invoke_benchmark", workspace, definition,
      arguments: { value: 9 }, runDir, result: initial });
    expect(executed.exitCode).toBe(0);
    expect(executed.stderr).toContain("native diagnostic");
    expect(executed.reply).toMatchObject({ ok: true, result: { runId: "reserved", status: "completed",
      trace: initial.trace, metrics: [{ id: "score", value: 9, unit: "points" }] } });
    const runs = await results(workspace);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result).toEqual(executed.reply.result);
    expect(runs[0]!.events.map(event => event.type)).toEqual(["benchmark_start", "benchmark_end"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a killed native benchmark retains its start and registered conditions without a false completion", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(join(workspace, "quality.py"), `from pathlib import Path
import time
from rsa_tools import benchmark, current_benchmark
@benchmark
def wait():
    """Wait after recording the model condition."""
    current_benchmark().conditions(checkpoint="step-42")
    Path("ready").touch()
    time.sleep(60)
`);
    child = Bun.spawn(["python3", "-B", "-c", "import quality; quality.wait()"], {
      cwd: workspace, env: environment(workspace, artifactRoot), stdout: "ignore", stderr: "pipe",
    });
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(workspace, "ready")).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(join(workspace, "ready")).exists()).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    const runs = await results(workspace);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result).toMatchObject({ status: "running", verdict: null, endedAt: null,
      conditions: { checkpoint: "step-42" } });
    expect(runs[0]!.events.map(event => event.type)).toEqual(["benchmark_start"]);
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
