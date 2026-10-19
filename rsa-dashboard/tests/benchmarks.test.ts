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
import { selectRunEvents } from "../lib/data";
import type { Event, Manifest } from "../lib/types";
import { benchmarkCatalog, benchmarkEvidence } from "../lib/benchmark-data";
import {
  benchmarkRunUrl,
  compatibleBaseline,
  comparisonChanges,
  resultKey,
  type BenchmarkResult,
} from "../lib/benchmarks";

const result = (patch: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  schemaVersion: 1,
  caseId: "ws-recovery",
  caseVersion: 1,
  title: "WS 到期恢复",
  mode: "offline",
  status: "failed",
  startedAt: "2026-10-19T01:00:00Z",
  endedAt: "2026-10-19T01:00:01Z",
  durationMs: 1000,
  runId: "new",
  project: "ws-bench",
  parameters: { model: null, seconds: 180, maxRequests: 30, seed: 7 },
  provenance: { code: null, prompts: {}, workspaceInstructionsSHA256: "abc" },
  checks: [
    {
      id: "recovery",
      label: "恢复",
      passed: false,
      expected: "WS 恢复",
      actual: "仍然 SSE",
      evidenceSeq: [2, 9],
    },
  ],
  metrics: [{ id: "requests", label: "请求数", value: null, unit: "次" }],
  ...patch,
});
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
  const manifest = {
    model: null,
    seconds: 180,
    drivers: [],
    benchmark: { caseId: "ws-recovery", caseVersion: 1, mode: "offline" },
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "benchmark.json"), JSON.stringify(result()));
  const definitions = join(base, "cases.json");
  await writeFile(
    definitions,
    JSON.stringify([
      { id: "ws-recovery", title: "WS 到期恢复", version: 1, mode: "offline" },
      { id: "capability-reuse", title: "能力复用", version: 1, mode: "live" },
    ]),
  );
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
  return {
    base,
    root,
    workspace,
    directory,
    definitions,
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}

test("catalog reads indexed benchmark sidecars across workspaces and keeps actual failure/unknown values", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "game/runs/play"), { recursive: true });
    await writeFile(
      join(f.root, "game/runs/play/manifest.json"),
      JSON.stringify({ model: "model", drivers: [], seconds: 20 }),
    );
    // Invalid content here must not be scanned: it is a game run, not a benchmark.
    await writeFile(join(f.root, "game/runs/play/benchmark.json"), "invalid");
    const data = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(data.cases.length, 2); // Never-run cases remain available.
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].status, "failed");
    assert.equal(data.results[0].checks[0].passed, false);
    assert.equal(data.results[0].metrics[0].value, null);
    assert.deepEqual(data.issues, []);
    await writeFile(
      join(f.directory, "benchmark.json"),
      JSON.stringify(result({ project: "another-workspace" })),
    );
    const invalid = await benchmarkCatalog(f.root, f.definitions);
    assert.equal(invalid.results.length, 0);
    assert.match(invalid.issues[0].error, /身份/);
  } finally {
    await f.cleanup();
  }
});

test("evidence resolves exact referenced events, exposes missing sequence and preserves epoch", async () => {
  const f = await fixture();
  try {
    const evidence = await benchmarkEvidence("ws-bench", "new", f.root);
    assert.deepEqual(
      evidence.events.map((event) => event.seq),
      [2],
    );
    assert.deepEqual(evidence.missingSeq, [9]);
    assert.equal(evidence.epoch, "first");
    assert.deepEqual(evidence.epochs, ["first"]);
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
      /当前运行目录/,
    );
  } finally {
    await f.cleanup();
  }
});

test("baseline requires case/version/mode identity but reports changed model, budget and seed", () => {
  const current = result(),
    baseline = result({ runId: "old" });
  assert.equal(resultKey(current), "ws-bench/new");
  assert.equal(compatibleBaseline(current, baseline), true);
  for (const patch of [
    { caseId: "other" },
    { caseVersion: 2 },
    { mode: "live" as const },
  ])
    assert.equal(compatibleBaseline(current, result(patch)), false);
  assert.deepEqual(comparisonChanges(current, baseline), []);
  assert.deepEqual(
    comparisonChanges(
      current,
      result({
        parameters: { model: "other", seconds: 60, maxRequests: 10, seed: 8 },
      }),
    ),
    ["模型", "时限", "请求预算", "随机种子"],
  );
});

test("offline benchmark trace epochs remain inspectable without fabricating takeover cycles", async () => {
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
    benchmark: { caseId: "ws-recovery", caseVersion: 1, mode: "offline" },
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
