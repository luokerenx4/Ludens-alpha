import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonModulePaths } from "../src/harness/python-capabilities.ts";
import { resolveWorkspaceState } from "../src/harness/workspace-state.ts";
import { benchmarkEventSummary, projectResult, validateExecution, validateResult, type BenchmarkDefinition, type BenchmarkExecution } from "../src/benchmark/contract.ts";

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
    const execution = JSON.parse(await readFile(join(directory, "benchmark.json"), "utf8")) as BenchmarkExecution;
    validateExecution(execution);
    const names = await readdir(join(directory, "reports")).catch(() => []);
    const reports = await Promise.all(names.filter(name => name.endsWith(".json") && !name.endsWith(".raw.json")).sort()
      .map(name => readFile(join(directory, "reports", name), "utf8").then(JSON.parse)));
    const result = projectResult(execution, reports);
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
@rsa.benchmark(protocol="2")
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
    expect(found.reply.benchmarks[0]).toMatchObject({ title: "Quality", source: "workspace", protocolVersion: "1",
      targets: ["python/model.py:predict"], parameters: { properties: { seed: { type: "integer", default: 7 } } } });
    expect(found.reply.benchmarks[1].protocolVersion).toBe("2");
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
    const source = `from pathlib import Path
from rsa_tools import benchmark, capability, current_benchmark
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
    artifact = Path("scores.txt")
    artifact.write_text("scores")
    context.artifact(artifact, label="Scores")
    return {"metrics": {"count": {"value": evaluate(), "unit": "calls"}}}
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
Path("scores.txt").write_text("changed after the experiment")
assert all(item[0] is identity for item in model.seen)
try:
    Client().call("python/model.py:quality")
except ValueError as error:
    assert "@capability" in str(error)
else:
    raise AssertionError("benchmark leaked into Controller capabilities")
print(json.dumps({"values": [first["metrics"]["count"]["value"], second["metrics"]["count"]["value"]],
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
        trace: { traceId: "parent-trace", parentSpanId: "parent-span" } });
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts![0]).toMatchObject({ label: "Scores", sha256: expect.any(String) });
      expect(await readFile(join(directory, result.artifacts![0]!.path), "utf8")).toBe("scores");
      expect(result.report?.errors).toEqual([]);
      expect(result.reports).toHaveLength(1);
      expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1);
      expect(events.filter(event => event.type === "benchmark_end")).toHaveLength(1);
      expect(events.map(event => event.type)).toEqual(["benchmark_start", "python_call_start", "python_call_end", "benchmark_end", "benchmark_report"]);
      expect(events.at(-1).data).toMatchObject(benchmarkEventSummary(result, result.report));
      expect(events[1].trace.parentSpanId).toBe(result.trace.spanId);
      expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5]);
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

test("benchmark artifacts reference shared nonvisual timeline originals across runs without copying media", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await writeFile(join(workspace, "evaluation.py"), `from rsa_tools import benchmark, current_benchmark
@benchmark
def evaluate(path: str):
    """Attach an already recorded observation."""
    current_benchmark().artifact(path, label="Recorded frame")
    return {}
`);
    const response = await python(workspace, artifactRoot, `import base64, json
from pathlib import Path
from rsa_tools._observation_history import ObservationHistory
import evaluation
history = ObservationHistory(Path.cwd())
record = history.append({"media": [{"data": base64.b64encode(b"shared frame").decode(), "mediaType": "application/octet-stream"}]}, "fixture",
                        {"clock": "fixture", "startedAtMs": 1, "finishedAtMs": 2})
history.close()
source = Path(record["media"][0]["path"])
evaluation.evaluate(str(source))
alias = Path("latest.png")
alias.symlink_to(source)
evaluation.evaluate(str(alias))
print(json.dumps({"path": source.relative_to(Path.cwd()).as_posix(), "asset": record["media"][0]["timeline"]["asset"]}))
`, { RSA_PERCEPTION_PERSIST: "1" });
    const runs = await results(workspace);
    expect(runs).toHaveLength(2);
    for (const { result, directory } of runs) {
      expect(result.status).toBe("completed");
      expect(result.artifacts).toEqual([{ path: response.path, sha256: expect.any(String),
        timeline: { asset: response.asset }, label: "Recorded frame" }]);
      expect(await readdir(join(directory, "artifacts"))).toEqual([]);
    }
    expect(await readdir(join(workspace, ".rsa", "timeline", "objects"))).toEqual([response.asset.split("/").at(-1)]);
    expect(await readFile(join(workspace, response.path), "utf8")).toBe("shared frame");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark image artifacts retain exact video-frame references across runs without copying frames or clips", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await writeFile(join(workspace, "evaluation.py"), `import json
from rsa_tools import benchmark, current_benchmark
@benchmark
def evaluate(media_json: str):
    """Attach a recorded frame, whether still encoding or already cold."""
    current_benchmark().artifact(json.loads(media_json), label="Recorded frame")
    return {}
`);
    const response = await python(workspace, artifactRoot, `import base64, copy, json
from io import BytesIO
from pathlib import Path
from PIL import Image
from rsa_tools._observation_history import ObservationHistory
from rsa_tools.benchmarks import BenchmarkContext
import evaluation
history = ObservationHistory(Path.cwd())
sampling = {"clock": "fixture", "startedAtMs": 1, "finishedAtMs": 2}
def capture(color, at):
    output = BytesIO()
    Image.new("RGB", (48, 32), color).save(output, format="PNG")
    return history.append({"media": [{"data": base64.b64encode(output.getvalue()).decode(), "mediaType": "image/png"}]},
                          "fixture", sampling, at)["media"][0]
first = capture((200, 20, 10), "2026-10-27T01:00:00.000Z")
evaluation.evaluate(json.dumps(first))  # The writer is alive; attaching must not take its lock.
second = capture((20, 200, 10), "2026-10-27T01:00:00.350Z")
history.close()
evaluation.evaluate(json.dumps(second["timeline"]))
context = BenchmarkContext(Path("logs/invalid"), {"workspace": str(Path.cwd())})
for key, value in [("recordId", "forged"), ("sequence", second["timeline"]["sequence"]), ("asset", "../escape")]:
    forged = {**first["timeline"], key: value}
    try: context.artifact(forged)
    except ValueError: pass
    else: raise AssertionError("forged reference accepted")
forged = copy.deepcopy(first["timeline"])
forged["video"]["pts"] += 1
try: context.artifact(forged)
except ValueError: pass
else: raise AssertionError("wrong video frame accepted")
print(json.dumps({"references": [first["timeline"], second["timeline"]]}))
`, { RSA_PERCEPTION_PERSIST: "1" });
    const runs = (await results(workspace)).sort((a, b) => a.result.artifacts![0]!.timeline!.sequence! - b.result.artifacts![0]!.timeline!.sequence!);
    expect(runs).toHaveLength(2);
    expect(response.references[0].asset).toBe(response.references[1].asset);
    expect(response.references.map((ref: any) => ref.video.pts)).toEqual([0, 350000]);
    for (const [index, { result, directory }] of runs.entries()) {
      expect(result.status).toBe("completed");
      expect(result.artifacts).toEqual([{ path: `.rsa/timeline/${response.references[index].asset}`,
        timeline: response.references[index], mediaType: "image/png", approximate: true, label: "Recorded frame" }]);
      expect(await readdir(join(directory, "artifacts"))).toEqual([]);
    }
    expect(await Bun.file(join(workspace, ".rsa/timeline/objects")).exists()).toBe(false);
    const files = await readdir(join(workspace, ".rsa/timeline/video"));
    expect(files.filter(name => name.endsWith(".mp4"))).toHaveLength(1);
    expect(files.filter(name => name.endsWith(".json"))).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark timeline references require canonical storage and matching content hashes", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    const response = await python(workspace, artifactRoot, `import hashlib, json
from pathlib import Path
from rsa_tools.benchmarks import BenchmarkContext
workspace = Path.cwd()
directory = workspace / "logs" / "fixture"
directory.mkdir(parents=True)
context = BenchmarkContext(directory, {"workspace": str(workspace)})
objects = workspace / ".rsa" / "timeline" / "objects"
objects.mkdir(parents=True)
digest = hashlib.sha256(b"original").hexdigest()
tampered = objects / (digest + ".bin")
tampered.write_bytes(b"changed")
changed = context.artifact(tampered)
outside = workspace.parent / "outside.bin"
outside.write_bytes(b"outside")
escape = objects / "escape.bin"
escape.symlink_to(outside)
try:
    context.artifact(escape)
except ValueError:
    pass
else:
    raise AssertionError("escaped the workspace")
escape.unlink()
tampered.unlink()
objects.rmdir()
elsewhere = workspace / "ordinary-objects"
elsewhere.mkdir()
objects.symlink_to(elsewhere, target_is_directory=True)
relocated = objects / (digest + ".bin")
relocated.write_bytes(b"original")
ordinary = context.artifact(relocated)
assert "timeline" not in changed and "timeline" not in ordinary
assert (directory / changed["path"]).read_bytes() == b"changed"
assert (directory / ordinary["path"]).read_bytes() == b"original"
print(json.dumps([changed, ordinary]))
`);
    expect(response).toHaveLength(2);
    expect(response.every((artifact: { path: string }) => artifact.path.startsWith("artifacts/"))).toBe(true);
    expect(await readdir(join(workspace, "logs", "fixture", "artifacts"))).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production report mistakes collect all errors after one execution, without converting measurements", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await writeFile(join(workspace, "evaluation.py"), `from rsa_tools import benchmark, current_benchmark
calls = []
@benchmark
def evaluate(kind: str):
    """Simulate one expensive action followed by a report."""
    calls.append(kind)
    if kind == "valid":
        seq = current_benchmark().record("measurement", {"distance": 4})
        return {"checks": {"reached": {"passed": True, "expected": True, "actual": True},
                           "distance": {"passed": True, "expected": 4, "actual": 4, "evidenceSeq": [seq]}}}
    if kind == "malformed":
        return {"metrics": {"duration": {"value": "slow"}, "missing_unit": {"value": 1, "unit": ""}},
                "checks": {"reached": {"passed": "yes"}}}
    if kind == "nan":
        return {"metrics": {"duration": {"value": float("nan"), "unit": "s"}}}
    return {"checks": {"native_object": {"passed": True, "actual": object()}}}
`);
    const child = Bun.spawn(["python3", "-B", "-c", `import json
import evaluation
for kind in ["valid", "malformed", "nan", "object"]:
    result = evaluation.evaluate(kind)
    assert isinstance(result, dict)
print(json.dumps(evaluation.calls))
`], { cwd: workspace, env: environment(workspace, artifactRoot), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(["valid", "malformed", "nan", "object"]);
    expect(stderr.match(/Repair without rerunning: rsa bench report/g)).toHaveLength(3);
    const runs = await results(workspace);
    expect(runs).toHaveLength(4);
    expect(runs.every(run => run.result.status === "completed")).toBe(true);
    const byKind = new Map(runs.map(run => [run.result.parameters.kind, run]));
    expect(byKind.get("valid")!.result).toMatchObject({ verdict: "passed", checks: [
      { id: "reached", label: "reached", passed: true, expected: true, actual: true, evidenceSeq: [] },
      { id: "distance", expected: 4, actual: 4, evidenceSeq: [2] },
    ] });
    const malformed = byKind.get("malformed")!.result.report!;
    expect(malformed.errors).toHaveLength(4);
    expect(malformed.errors.map(error => error.path)).toEqual([
      "/checks/reached/passed", "/metrics/duration", "/metrics/duration/value", "/metrics/missing_unit/unit",
    ]);
    expect(malformed.outcome).toBeNull();
    expect(malformed.raw).toMatchObject({ metrics: { duration: { value: "slow" } } });
    const nan = byKind.get("nan")!.result;
    expect(nan.verdict).toBeNull();
    expect(nan.report).toMatchObject({ raw: null, outcome: null,
      errors: [{ path: "/metrics/duration/value", message: expect.stringContaining("finite") }] });
    expect(nan.report!.rawText).toContain("nan");
    expect(byKind.get("object")!.result.report).toMatchObject({ raw: null, outcome: null,
      errors: [{ path: "/checks/native_object/actual", message: expect.stringContaining("JSON") }] });
    for (const { result, events, directory } of runs) {
      expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1);
      expect(events.slice(-2).map(event => event.type)).toEqual(["benchmark_end", "benchmark_report"]);
      expect(events.at(-2).data).toMatchObject(benchmarkEventSummary(result));
      expect(events.at(-1).data).toMatchObject(benchmarkEventSummary(result, result.report));
      const raw = JSON.parse(await readFile(join(directory, "reports", result.report!.id + ".raw.json"), "utf8"));
      expect(raw.raw).toEqual(result.report!.raw);
      expect(raw.rawText).toBe(result.report!.rawText);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark bridge exposes an import failure as load, before execution starts", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    await writeFile(join(workspace, "evaluation.py"), `from rsa_tools import benchmark
from missing_actions import pause_menu_visible
@benchmark
def evaluate():
    """This entry cannot load."""
    return {}
`);
    const discovery = await bridge(workspace, artifactRoot, { action: "discover_benchmarks", workspace });
    const definition = discovery.reply.benchmarks[0];
    const executed = await bridge(workspace, artifactRoot, { action: "invoke_benchmark", workspace,
      definition, arguments: {}, runDir: join(workspace, "logs", "reserved"), result: { status: "running" } });
    expect(executed.exitCode).toBe(1);
    expect(executed.reply).toMatchObject({ ok: false, error: {
      type: "ModuleNotFoundError", message: "No module named 'missing_actions'", phase: "load",
    } });
    expect(await Bun.file(join(workspace, "logs", "reserved", "events.jsonl")).exists()).toBe(false);
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
    raise LookupError("original failure")
@benchmark
def no_checks():
    """Record an observation without claiming success."""
    return None
`);
    expect(await python(workspace, artifactRoot, `import json
import evaluation
seen = []
for kind in ["error", "cancel"]:
    try:
        evaluation.fail(kind)
    except BaseException as error:
        seen.append(type(error).__name__)
assert evaluation.no_checks() is None
print(json.dumps(seen))
`)).toEqual(["LookupError", "KeyboardInterrupt"]);
    const runs = await results(workspace);
    expect(runs).toHaveLength(3);
    const byKind = new Map(runs.map(run => [run.result.parameters.kind, run.result]));
    expect(byKind.get("error")).toMatchObject({ status: "error", verdict: null, error: "LookupError: original failure",
      conditions: { stage: "registered" } });
    expect(byKind.get("cancel")).toMatchObject({ status: "cancelled", verdict: null });
    expect(byKind.get(undefined)).toMatchObject({ status: "completed", verdict: null, checks: [], metrics: [] });
    for (const { result, events } of runs) {
      expect(result.endedAt).not.toBeNull();
      expect(events.some(event => event.type === "benchmark_end")).toBe(true);
      expect(events.find(event => event.type === "benchmark_end").data).toMatchObject(benchmarkEventSummary(result));
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
    return {"metrics": {"score": {"value": value, "unit": "points"}}}
`);
    const discovery = await bridge(workspace, artifactRoot, { action: "discover_benchmarks", workspace });
    const definition: BenchmarkDefinition = discovery.reply.benchmarks[0];
    const state = await resolveWorkspaceState(workspace, artifactRoot);
    const runDir = join(workspace, "logs", "reserved");
    await mkdir(runDir);
    const initial: BenchmarkExecution = { schemaVersion: 3, definition, status: "running",
      startedAt: new Date().toISOString(), endedAt: null, durationMs: null, runId: "reserved", project: state.id,
      workspace, trace: { traceId: "cli-trace", spanId: "cli-span" }, parameters: { value: 9 }, provenance: {},
      conditions: {}, subjects: [], artifacts: [], limitations: [] };
    await writeFile(join(runDir, "benchmark.json"), JSON.stringify(initial));
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId: "reserved" }));
    const executed = await bridge(workspace, artifactRoot, { action: "invoke_benchmark", workspace, definition,
      arguments: { value: 9 }, runDir, result: initial });
    expect(executed.exitCode).toBe(0);
    expect(executed.stderr).toContain("native diagnostic");
    expect(executed.reply).toMatchObject({ ok: true, result: { runId: "reserved", status: "completed",
      trace: initial.trace } });
    const runs = await results(workspace);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result).toMatchObject(executed.reply.result);
    expect(runs[0]!.result.metrics).toEqual([{ id: "score", value: 9, unit: "points", direction: "none" }]);
    expect(runs[0]!.events.map(event => event.type)).toEqual(["benchmark_start", "benchmark_end", "benchmark_report"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report correction follows its parent within one millisecond and retains the scoring protocol", async () => {
  const { root, workspace, artifactRoot } = await fixture();
  try {
    const response = await python(workspace, artifactRoot, `import json
from pathlib import Path
from rsa_tools._benchmark_report import write_report
directory = Path("run")
(directory / "reports").mkdir(parents=True)
base = {"schemaVersion": 1, "runId": "run", "createdAt": "2026-10-21T00:00:00.000Z",
        "reason": "initial", "raw": {}, "errors": [], "outcome": {"checks": [], "metrics": []}}
first = {**base, "id": "2026-10-21T00-00-00.000Z-ffffffff", "previousReportId": None, "protocolVersion": "1"}
second = {**base, "id": "2026-10-21T00-00-00.000Z-00000000", "previousReportId": first["id"], "protocolVersion": "2"}
for report in [first, second]:
    (directory / "reports" / (report["id"] + ".json")).write_text(json.dumps(report))
third = write_report(directory, {"runId": "run", "definition": {"protocolVersion": "1"}}, {}, reason="correction")
print(json.dumps({"previous": third["previousReportId"], "protocol": third["protocolVersion"]}))
`);
    expect(response).toEqual({ previous: "2026-10-21T00-00-00.000Z-00000000", protocol: "2" });
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
