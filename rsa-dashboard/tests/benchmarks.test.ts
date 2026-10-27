import {
  projectResult,
  type BenchmarkExecution,
} from "../../rsa/src/benchmark/contract";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog, selectRunEvents } from "../lib/data";
import { initialSelection, latestGameRun } from "../lib/initial-selection";
import type { Event, Manifest } from "../lib/types";
import { benchmarkCatalog, benchmarkEvidence } from "../lib/benchmark-data";
import {
  benchmarkCommand,
  benchmarkReportCommand,
  benchmarkSelection,
  displayCheckValue,
  benchmarkRunUrl,
  compareResults,
  compatibleBaseline,
  comparisonChanges,
  definitionKey,
  resultKey,
  resultLabel,
  type BenchmarkDefinition,
  type BenchmarkResult,
  type BenchmarkReport,
} from "../lib/benchmarks";

const definition = (
  patch: Partial<BenchmarkDefinition> = {},
): BenchmarkDefinition => ({
  id: "ws-recovery",
  title: "WS 到期恢复",
  description: "恢复连接",
  scope: "本地模拟传输",
  revision: "2",
  source: "builtin",
  protocolVersion: "1",
  parameters: {},
  targets: [],
  entry: { kind: "builtin", caseId: "ws-recovery" },
  ...patch,
});
const result = (patch: Partial<BenchmarkResult> = {}): BenchmarkResult => {
  const execution: BenchmarkExecution = {
    schemaVersion: 3,
    definition: definition(),
    status: "completed",
    startedAt: "2026-10-19T01:00:00Z",
    endedAt: "2026-10-19T01:00:01Z",
    durationMs: 1000,
    runId: "new",
    project: "ws-bench",
    workspace: "/workspace",
    trace: {},
    parameters: { model: null, seconds: 180, maxRequests: 30, seed: 7 },
    provenance: { code: null },
    ...patch,
  };
  const checks = patch.checks ?? [
    {
      id: "recovery",
      label: "恢复",
      passed: false,
      expected: "WS 恢复",
      actual: "仍然 SSE",
      evidenceSeq: [2, 9],
    },
  ];
  const metrics = patch.metrics ?? [
    { id: "requests", label: "请求数", value: null, unit: "次" },
  ];
  const report: BenchmarkReport = {
    schemaVersion: 1,
    id: "report-1",
    runId: execution.runId,
    createdAt: "2026-10-19T01:00:01Z",
    previousReportId: null,
    reason: "initial",
    protocolVersion: execution.definition.protocolVersion,
    raw: {
      checks: Object.fromEntries(checks.map(({ id, ...value }) => [id, value])),
      metrics: Object.fromEntries(
        metrics.map(({ id, ...value }) => [id, value]),
      ),
    },
    errors: [],
    outcome: { checks, metrics },
  };
  return projectResult(execution, patch.reports ?? [report], patch.report?.id);
};
function executionOnly(value: BenchmarkResult): BenchmarkExecution {
  const {
    checks: _checks,
    metrics: _metrics,
    verdict: _verdict,
    report: _report,
    reports: _reports,
    ...execution
  } = value;
  return execution;
}
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "rsa-bench-dashboard-"));
  const base = await realpath(temp),
    root = join(base, "artifacts"),
    workspace = join(base, "clean-workspace"),
    directory = join(workspace, "logs/new");
  await mkdir(join(root, "ws-bench"), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(root, "ws-bench/workspace.json"),
    JSON.stringify({ workspace }),
  );
  const save = async (value: BenchmarkResult) => {
    const path = join(workspace, "logs", value.runId);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        kind: "benchmark",
        model: null,
        seconds: 180,
        drivers: [],
        benchmark: {
          id: value.definition.id,
          revision: value.definition.revision,
          protocolVersion: value.definition.protocolVersion,
        },
      }),
    );
    await writeFile(
      join(path, "benchmark.json"),
      JSON.stringify({ ...executionOnly(value), workspace }),
    );
    await mkdir(join(path, "reports"), { recursive: true });
    for (const report of value.reports)
      await writeFile(
        join(path, "reports", `${report.id}.json`),
        JSON.stringify(report),
      );
    return path;
  };
  await save(result());
  await writeFile(
    join(directory, "events.jsonl"),
    [
      {
        seq: 1,
        type: "control",
        trace: { epoch: "first" },
        data: { mode: "auto" },
      },
      {
        seq: 2,
        type: "model_end",
        trace: { epoch: "first", modelCallId: "call" },
        data: { stopReason: "error" },
      },
      { seq: 3, type: "unrelated", trace: {}, data: { text: "not evidence" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const definitions = [
    definition(),
    definition({ id: "capability-reuse", title: "能力复用" }),
  ];
  return {
    base,
    root,
    workspace,
    directory,
    definitions,
    save,
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}

test("unified catalog preserves execution/check distinction and does not inspect game sidecars", async () => {
  const f = await fixture();
  try {
    const game = join(f.workspace, "logs/game");
    await mkdir(game);
    await writeFile(
      join(game, "manifest.json"),
      JSON.stringify({ model: "model", drivers: [], seconds: 20 }),
    );
    await writeFile(join(game, "benchmark.json"), "invalid");
    const data = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(data.benchmarks.length, 2);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].status, "completed");
    assert.equal(data.results[0].verdict, "failed");
    assert.equal(data.results[0].checks[0].passed, false);
    assert.equal(data.results[0].metrics[0].value, null);
    assert.deepEqual(data.issues, []);
    await writeFile(
      join(f.directory, "benchmark.json"),
      JSON.stringify({
        ...executionOnly(result({ project: "another-workspace" })),
        workspace: f.workspace,
      }),
    );
    const invalid = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(invalid.results.length, 0);
    assert.match(invalid.issues[0].error, /身份/);
  } finally {
    await f.cleanup();
  }
});

test("many evaluations share a workspace and metrics-only completion has no invented verdict", async () => {
  const f = await fixture();
  try {
    const measured = result({
      runId: "z-second",
      parentRunId: "game",
      checks: [],
      verdict: null,
      metrics: [{ id: "latency", value: 23, unit: "ms", direction: "lower" }],
    });
    await f.save(measured);
    await f.save(
      result({
        runId: "z-third",
        status: "error",
        verdict: null,
        checks: [],
        error: "sample unavailable",
      }),
    );
    const data = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(data.results.length, 3);
    const found = data.results.find((item) => item.runId === measured.runId)!;
    assert.equal(found.parentRunId, "game");
    assert.equal(resultLabel(found), "已完成");
    assert.equal(resultKey(found), "ws-bench/z-second");
    assert.equal(
      resultLabel(data.results.find((item) => item.runId === "z-third")!),
      "执行异常",
    );
  } finally {
    await f.cleanup();
  }
});

test("snapshots list never-run workspace definitions and retain deleted definitions from results", async () => {
  const f = await fixture();
  try {
    const workspaceDefinition = definition({
      id: "python/evaluate.py:score",
      source: "workspace",
      revision: "source-hash",
      targets: ["python/vision.py:locate"],
      entry: {
        kind: "python",
        path: "evaluate.py",
        function: "score",
        codeSHA: "source-hash",
      },
    });
    const neverRunWorkspace = join(f.base, "never-run");
    await mkdir(join(neverRunWorkspace, "logs"), { recursive: true });
    await mkdir(join(f.root, "ws-never"));
    await writeFile(
      join(f.root, "ws-never/workspace.json"),
      JSON.stringify({ workspace: neverRunWorkspace }),
    );
    await writeFile(
      join(neverRunWorkspace, "logs/benchmarks-catalog.json"),
      JSON.stringify({ benchmarks: [workspaceDefinition], diagnostics: [] }),
    );
    await f.save(result({ definition: workspaceDefinition }));
    const data = await benchmarkCatalog(f.root, f.definitions);
    const current = data.benchmarks.find(
      (item) => item.key === definitionKey(workspaceDefinition, "ws-never"),
    )!;
    const historical = data.benchmarks.find(
      (item) => item.key === definitionKey(workspaceDefinition, "ws-bench"),
    )!;
    assert.equal(current.available, true);
    assert.equal(current.workspace, neverRunWorkspace);
    assert.equal(historical.available, false);
    assert.deepEqual(
      historical.definition.targets,
      workspaceDefinition.targets,
    );
    assert.match(
      benchmarkCommand(current),
      /--workspace .* bench run 'python\/evaluate.py:score'/,
    );
    assert.deepEqual(data.issues, []);
  } finally {
    await f.cleanup();
  }
});

test("old, mismatched and corrupt results are isolated as issues", async () => {
  const f = await fixture();
  try {
    const old = await f.save(result({ runId: "old" }));
    await writeFile(
      join(old, "benchmark.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    const broken = await f.save(result({ runId: "broken" }));
    await writeFile(join(broken, "benchmark.json"), "{unfinished");
    const mismatch = await f.save(result({ runId: "mismatch" }));
    await writeFile(
      join(mismatch, "benchmark.json"),
      JSON.stringify({
        ...executionOnly(
          result({
            runId: "mismatch",
            definition: definition({ revision: "other" }),
          }),
        ),
        workspace: f.workspace,
      }),
    );
    await writeFile(
      join(f.workspace, "logs/benchmarks-catalog.json"),
      JSON.stringify({
        benchmarks: [],
        diagnostics: [{ path: "bad.py", message: "unsupported declaration" }],
      }),
    );
    const data = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(data.results.length, 1);
    assert.equal(data.issues.length, 4);
    assert.ok(data.issues.some((issue) => issue.error.includes("manifest")));
    assert.ok(
      data.issues.some((issue) =>
        issue.error.includes("unsupported declaration"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("evidence resolves committed events, exposes missing sequences and rejects symlink escape", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "events.jsonl"), '{"seq":9', { flag: "a" });
    const evidence = await benchmarkEvidence("ws-bench", "new", f.root);
    assert.deepEqual(
      evidence.events.map((event) => event.seq),
      [2],
    );
    assert.deepEqual(evidence.missingSeq, [9]);
    assert.equal(evidence.epoch, "first");
    const url = new URL(
      benchmarkRunUrl(
        evidence.result,
        evidence.events[0].trace.epoch,
        evidence.events[0],
      ),
      "http://localhost",
    );
    assert.equal(url.searchParams.get("project"), "ws-bench");
    assert.equal(url.searchParams.get("run"), "new");
    assert.equal(url.searchParams.get("epoch"), "first");
    assert.equal(url.searchParams.get("call"), "call");
    assert.equal(url.searchParams.get("bench"), null);
    await assert.rejects(
      benchmarkEvidence("../ws-bench", "new", f.root),
      /无效/,
    );
    await rm(join(f.directory, "benchmark.json"));
    const external = join(f.base, "outside.json");
    await writeFile(external, JSON.stringify(result()));
    await symlink(external, join(f.directory, "benchmark.json"));
    await assert.rejects(
      benchmarkEvidence("ws-bench", "new", f.root),
      /workspace logs/,
    );
  } finally {
    await f.cleanup();
  }
});

test("shared comparison reports condition/subject changes and rejects metric unit/direction deltas", () => {
  const current = result({
    metrics: [
      { id: "accuracy", value: 0.9, unit: "ratio", direction: "higher" },
    ],
    subjects: [{ id: "model", sha256: "new" }],
  });
  const baseline = result({
    runId: "old",
    metrics: [
      { id: "accuracy", value: 0.8, unit: "ratio", direction: "higher" },
    ],
    subjects: [{ id: "model", sha256: "old" }],
  });
  assert.equal(compatibleBaseline(current, baseline), true);
  assert.deepEqual(comparisonChanges(current, baseline), []);
  const compared = compareResults(current, baseline);
  assert.equal(compared.subjectsChanged, true);
  assert.ok(compared.metrics[0].delta! > 0.09);
  const changed = result({
    definition: definition({ revision: "3", protocolVersion: "2" }),
    parameters: {},
    conditions: { dataset: "other" },
  });
  assert.equal(compatibleBaseline(current, changed), false);
  assert.deepEqual(comparisonChanges(current, changed), [
    "评测口径",
    "参数",
    "评测条件",
  ]);
  for (const metric of [
    { id: "accuracy", value: 80, unit: "%", direction: "higher" as const },
    { id: "accuracy", value: 0.8, unit: "ratio", direction: "lower" as const },
  ]) {
    const comparison = compareResults(current, result({ metrics: [metric] }));
    assert.equal(comparison.metrics[0].delta, null);
    assert.equal(comparison.metrics[0].comparable, false);
  }
});

test("newer benchmark runs do not replace the latest game selection", async () => {
  const f = await fixture();
  try {
    const game = join(f.workspace, "logs/game");
    await mkdir(game);
    await writeFile(
      join(game, "manifest.json"),
      JSON.stringify({ model: "model", drivers: [], seconds: 20 }),
    );
    const projects = await catalog(f.root);
    assert.equal(projects[0].runs[0].kind, "benchmark");
    assert.equal(latestGameRun(projects[0])?.id, "game");
    assert.deepEqual(initialSelection("?project=ws-bench", projects), {
      project: "ws-bench",
      run: "",
      epoch: "",
    });
    assert.equal(
      initialSelection("?project=ws-bench&run=new", projects).run,
      "new",
    );
  } finally {
    await f.cleanup();
  }
});

test("trace epochs remain inspectable without fabricating takeover cycles", async () => {
  const events: Event[] = [
    {
      seq: 1,
      at: "2026-10-19T01:00:00Z",
      atMs: 0,
      type: "model_start",
      trace: { epoch: "fixture", modelCallId: "call" },
      data: {},
    },
  ];
  const manifest = {
    kind: "benchmark",
    benchmark: { id: "ws-recovery", revision: "2", protocolVersion: "1" },
  } as Manifest;
  const scope = selectRunEvents(manifest, events);
  assert.equal(scope.selectedEpoch, null);
  assert.deepEqual(scope.cycles, []);
  assert.deepEqual(scope.events, events);
  assert.deepEqual(selectRunEvents({} as Manifest, events).events, []);
  assert.throws(() => selectRunEvents(manifest, events, "fixture"), /周期/);
  const f = await fixture();
  try {
    await writeFile(
      join(f.directory, "events.jsonl"),
      JSON.stringify({ ...events[0], seq: 2 }) + "\n",
    );
    const proof = await benchmarkEvidence("ws-bench", "new", f.root);
    assert.equal(proof.epoch, null);
    assert.deepEqual(proof.epochs, []);
    assert.equal(proof.events[0].trace.epoch, "fixture");
  } finally {
    await f.cleanup();
  }
});

test("report revisions preserve trial count, latest invalid report is visible, and links pin both versions", async () => {
  const f = await fixture();
  try {
    const original = result();
    const valid = original.report!;
    const invalid: BenchmarkReport = {
      ...valid,
      id: "report-2",
      createdAt: "2026-10-19T01:00:02Z",
      previousReportId: valid.id,
      reason: "bad revision",
      raw: { metrics: { latency: { value: "bad" } } },
      errors: [
        {
          path: "metrics.latency.value",
          message: "expected finite number or null",
        },
      ],
      outcome: null,
    };
    await writeFile(
      join(f.directory, "reports/report-2.json"),
      JSON.stringify(invalid),
    );
    const data = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].reports.length, 2);
    assert.equal(data.results[0].status, "completed");
    assert.equal(data.results[0].report?.id, "report-2");
    assert.equal(data.results[0].verdict, null);
    assert.equal(data.results[0].checks.length, 0);
    assert.equal(
      data.results[0].report?.errors[0].path,
      "metrics.latency.value",
    );
    const pinned = await benchmarkEvidence(
      "ws-bench",
      "new",
      f.root,
      "report-1",
    );
    assert.equal(pinned.result.verdict, "failed");
    assert.deepEqual(
      pinned.events.map((event) => event.seq),
      [2],
    );
    await assert.rejects(
      benchmarkEvidence("ws-bench", "new", f.root, "not-found"),
      /report not found/,
    );
    const baseline = result({ runId: "old", report: undefined });
    const selection = benchmarkSelection(pinned.result, baseline);
    assert.equal(selection.report, "report-1");
    assert.equal(selection.baselineReport, "report-1");
    const compared = compareResults(pinned.result, baseline);
    assert.deepEqual(compared.reports, {
      result: "report-1",
      baseline: "report-1",
    });
    assert.equal(compared.sameExecution, false);
    const revisionComparison = compareResults(pinned.result, data.results[0]);
    assert.equal(revisionComparison.sameExecution, true);
    assert.deepEqual(revisionComparison.reports, {
      result: "report-1",
      baseline: "report-2",
    });
    assert.equal(revisionComparison.compatible, false);
    assert.match(
      benchmarkReportCommand(pinned.result),
      /bench report 'new' --file report.json/,
    );
  } finally {
    await f.cleanup();
  }
});

test("load failure and missing logs do not become offline mode or a passing verdict", async () => {
  const f = await fixture();
  try {
    await f.save(
      result({
        status: "error",
        error: "ImportError: missing_dependency",
        errorPhase: "load",
        checks: [{ id: "ok", label: "ok", passed: true, evidenceSeq: [] }],
      }),
    );
    await rm(join(f.directory, "events.jsonl"));
    const proof = await benchmarkEvidence("ws-bench", "new", f.root);
    assert.equal(proof.result.errorPhase, "load");
    assert.equal(proof.result.report?.outcome?.checks[0].passed, true);
    assert.equal(proof.result.verdict, null);
    assert.equal(proof.logAvailable, false);
    assert.deepEqual(proof.events, []);
    assert.equal("mode" in proof.result.definition, false);
    assert.equal(displayCheckValue({ count: 3 }), '{"count":3}');
    assert.equal(displayCheckValue(null), "null");
    assert.equal(displayCheckValue(undefined), "未提供");
    assert.doesNotMatch(
      benchmarkCommand({
        key: "builtin/ws-recovery",
        definition: definition(),
        available: true,
      }),
      /--live/,
    );
  } finally {
    await f.cleanup();
  }
});

test("benchmark source identities distinguish colliding service seqs from local numeric evidence", async () => {
  const f = await fixture();
  try {
    await f.save(result({ checks: [{ id: "source", label: "source", passed: true, evidenceSeq: [2, 9], evidenceEvents: ["service:2", "service:9", "service:missing"] }] }));
    const source = join(f.base, "device-source"); await mkdir(join(source, "events"), { recursive: true });
    await writeFile(join(source, "source.json"), JSON.stringify({ sourceId: "service", format: "baseware-events-v1" }));
    await writeFile(join(source, "events", "2026-10-27-2.jsonl"), [2, 9].map(seq => JSON.stringify({ seq, at: new Date(seq * 1000).toISOString(), atMs: seq * 1000,
      type: "action_end", trace: { recordingId: "new", epoch: "first" }, data: { status: "completed" },
      origin: { eventId: `service:${seq}`, clockId: "service", seq } })).join("\n") + "\n");
    await writeFile(join(f.directory, "manifest.json"), JSON.stringify({ kind: "benchmark", eventSources: [{ sourceId: "service", root: source,
      format: "baseware-events-v1", recordingId: "new", windows: [] }] }));
    const proof = await benchmarkEvidence("ws-bench", "new", f.root);
    assert.equal(proof.events[0].type, "model_end");
    assert.deepEqual(proof.events.slice(1).map(event => event.origin?.eventId), ["service:2", "service:9"]);
    assert.deepEqual(proof.missingSeq, [9]); assert.deepEqual(proof.missingEvents, ["service:missing"]);
  } finally { await f.cleanup(); }
});
