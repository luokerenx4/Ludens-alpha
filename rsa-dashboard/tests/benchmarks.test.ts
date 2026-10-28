import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trialSummary, type Trial, type Verification, type EvidenceReference, type BenchmarkResult } from "../../rsa/src/benchmark/contract";
import { readTask } from "../../rsa/src/benchmark/task";
import { importLegacyTrial } from "../../rsa/src/benchmark/legacy-import";
import { catalog, clearCatalogCache } from "../lib/data";
import { initialSelection, latestGameRun } from "../lib/initial-selection";
import { benchmarkAttachment, benchmarkCatalog, benchmarkEvidence } from "../lib/benchmark-data";
import { benchmarkCommand, benchmarkVerifyCommand, benchmarkSelection, benchmarkRunUrl, compareResults, parseBenchmarkRequest, parseResultKey, resultKey, resultLabel, evidenceLabel } from "../lib/benchmarks";
import type { Event } from "../lib/types";

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const at = "2026-10-28T01:00:00.000Z";
async function taskPackage(directory: string, name = "fixture/capability", extra = "") {
  await mkdir(join(directory, "environment"), { recursive: true });
  await mkdir(join(directory, "tests"), { recursive: true });
  await writeFile(join(directory, "task.toml"), `schema_version = "1.4"\n[task]\nname = "${name}"\ndescription = "能力测试"\n${extra}`);
  await writeFile(join(directory, "instruction.md"), "Measure a capability.");
  await writeFile(join(directory, "tests/test.sh"), "touch MUST_NOT_EXECUTE\n");
  return readTask(directory);
}
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-bench-dashboard-"));
  const base = await realpath(temporary), root = join(base, "artifacts"), workspace = join(base, "workspace"), repository = join(base, "tasks");
  await mkdir(join(root, "ws-bench"), { recursive: true });
  await mkdir(join(workspace, "logs"), { recursive: true });
  await json(join(root, "ws-bench/workspace.json"), { workspace });
  const task = await taskPackage(join(repository, "capability"));
  const make = (id = "run-010", patch: Partial<Trial> = {}): Trial => ({
    schemaVersion: 1, id, runId: id, task: { name: task.name, digest: task.digest }, project: "ws-bench", workspace,
    status: "completed", startedAt: at, endedAt: "2026-10-28T01:00:01.000Z", durationMs: 1000,
    parameters: { seed: 7 }, conditions: { backend: "native" }, subjects: [{ id: "capability", revision: "v1" }], evidence: [], ...patch,
  });
  const save = async (trial: Trial) => {
    const directory = join(workspace, "logs", trial.runId);
    await mkdir(directory, { recursive: true });
    await json(join(directory, "manifest.json"), { runId: trial.runId, kind: "benchmark", model: null, seconds: 1, drivers: [], benchmark: trial.task, workspace });
    await json(join(directory, "trial.json"), trial);
    await json(join(directory, "trial-summary.json"), trialSummary(trial));
    clearCatalogCache();
    return directory;
  };
  const verify = async (trial: Trial, id = "verify-010", patch: Partial<Verification> = {}, rewards: Record<string, number> = { success: 0 }) => {
    const verification: Verification = { schemaVersion: 1, id, trialId: trial.id, task: trial.task, status: "completed", startedAt: at, endedAt: "2026-10-28T01:00:02.000Z", reason: "initial", evidence: [], ...patch };
    const directory = join(workspace, "logs", trial.id, "verifier", id);
    await mkdir(directory, { recursive: true });
    await json(join(directory, "verification.json"), verification);
    await json(join(directory, "reward.json"), rewards);
    return verification;
  };
  return { base, root, workspace, repository, task, make, save, verify, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("catalog discovers task packages without executing author programs, and keeps unsupported requirements explicit", async () => {
  const f = await fixture();
  try {
    await taskPackage(join(f.workspace, "benchmarks/tasks/custom"), "workspace/custom", "[environment]\ndocker_image = 'image:tag'\n");
    await mkdir(join(f.workspace, "benchmarks/tasks/broken"), { recursive: true });
    await writeFile(join(f.workspace, "benchmarks/tasks/broken/task.toml"), "not toml");
    await f.save(f.make());
    const page = await benchmarkCatalog({}, f.root, f.repository);
    assert.equal(page.project, "ws-bench");
    assert.deepEqual(page.tasks.map(task => [task.name, task.source]), [["fixture/capability", "repository"], ["workspace/custom", "workspace"]]);
    assert.ok(page.tasks[1].unsupportedRequirements.includes("environment.docker_image"));
    assert.equal(page.issues.length, 1);
    assert.equal(page.history.trials.length, 1);
    assert.equal("verifier_result" in page.history.trials[0], false);
    await assert.rejects(access(join(f.repository, "capability/MUST_NOT_EXECUTE")));
  } finally { await f.cleanup(); }
});

test("history is paged from summaries without reading full trial or reward payloads", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 32; i++) {
      const trial = f.make(`run-${String(i).padStart(3, "0")}`);
      const directory = await f.save(trial);
      await writeFile(join(directory, "trial.json"), "deliberately invalid full detail");
      await mkdir(join(directory, "verifier/broken"), { recursive: true });
      await writeFile(join(directory, "verifier/broken/reward.json"), "invalid reward");
    }
    const first = await benchmarkCatalog({ project: "ws-bench", limit: 25 }, f.root, f.repository);
    assert.equal(first.history.trials.length, 25);
    assert.equal(first.history.trials[0].id, "run-031");
    assert.equal(first.history.nextCursor, "run-007");
    const second = await benchmarkCatalog({ project: "ws-bench", cursor: first.history.nextCursor, limit: 25 }, f.root, f.repository);
    assert.deepEqual(second.history.trials.map(trial => trial.id), ["run-006", "run-005", "run-004", "run-003", "run-002", "run-001", "run-000"]);
    assert.equal(second.history.nextCursor, undefined);
    assert.equal(first.history.issues.length, 0);
    await assert.rejects(benchmarkEvidence("ws-bench", "run-000", {}, f.root), /JSON|Unexpected/);
  } finally { await f.cleanup(); }
});

test("selected historical execution remains readable without a current task or live Host", async () => {
  const f = await fixture();
  try {
    const trial = f.make("old-trial", { selectedVerificationId: "verify-010" });
    await f.save(trial); await f.verify(trial);
    await rm(f.repository, { recursive: true });
    const list = await benchmarkCatalog({ taskName: trial.task.name }, f.root, f.repository);
    assert.equal(list.tasks.length, 0);
    assert.equal(list.history.trials[0].id, trial.id);
    const proof = await benchmarkEvidence("ws-bench", trial.id, {}, f.root);
    assert.equal(proof.result.trial.status, "completed");
    assert.deepEqual(proof.result.verifier_result.rewards, { success: 0 });
    assert.equal(resultLabel(proof.result), "执行完成 · 评分完成");
    assert.equal("verdict" in proof.result, false);
  } finally { await f.cleanup(); }
});

test("verification pagination and explicit selection never mix stale scores into a failed re-verification", async () => {
  const f = await fixture();
  try {
    const trial = f.make("run-010", { selectedVerificationId: "verify-012" });
    await f.save(trial);
    for (let i = 0; i <= 12; i++) await f.verify(trial, `verify-${String(i).padStart(3, "0")}`, i === 12 ? { status: "error", error: { code: "INVALID_REWARD", message: "invalid output" } } : {}, { success: i });
    const latest = await benchmarkEvidence("ws-bench", trial.id, {}, f.root);
    assert.equal(latest.result.trial.status, "completed");
    assert.equal(latest.result.verification?.status, "error");
    assert.equal(latest.result.verifier_result.rewards, null);
    assert.equal(resultLabel(latest.result), "执行完成 · 评分异常");
    assert.equal(latest.verifications.verifications.length, 10);
    assert.equal(latest.verifications.nextCursor, "verify-003");
    const pinned = await benchmarkEvidence("ws-bench", trial.id, { verification: "verify-001", verificationCursor: latest.verifications.nextCursor }, f.root);
    assert.equal(pinned.result.verification?.id, "verify-001");
    assert.deepEqual(pinned.result.verifier_result.rewards, { success: 1 });
    assert.equal(pinned.verifications.verifications.length, 3);
    assert.equal(pinned.verifications.nextCursor, undefined);
  } finally { await f.cleanup(); }
});

test("unscored, cancelled and execution-error trials do not acquire scores from old output files", async () => {
  const f = await fixture();
  try {
    for (const status of ["completed", "cancelled", "error"] as const) {
      const trial = f.make(status, { status, ...(status === "error" ? { error: { code: "EXECUTION", message: "program failed" } } : {}) });
      await f.save(trial); await f.verify(trial, "unselected");
      const proof = await benchmarkEvidence("ws-bench", status, {}, f.root);
      assert.equal(proof.result.verification, null);
      assert.equal(proof.result.verifier_result.rewards, null);
      assert.equal(proof.result.trial.status, status);
      assert.equal(proof.verifications.verifications.length, 1);
    }
  } finally { await f.cleanup(); }
});

test("workspace and manifest identity checks reject foreign summaries and detail paths", async () => {
  const f = await fixture();
  try {
    await f.save(f.make("wrong-project", { project: "foreign" }));
    const mismatch = f.make("wrong-task");
    const directory = await f.save(mismatch);
    await json(join(directory, "manifest.json"), { kind: "benchmark", benchmark: { name: "other/task", digest: mismatch.task.digest }, drivers: [] });
    const list = await benchmarkCatalog({}, f.root, f.repository);
    assert.equal(list.history.trials.length, 0);
    assert.equal(list.history.issues.length, 2);
    await assert.rejects(benchmarkEvidence("ws-bench", "wrong-project", {}, f.root), /身份不一致/);
    await assert.rejects(benchmarkEvidence("ws-bench", "wrong-task", {}, f.root), /身份不一致/);
    await assert.rejects(benchmarkEvidence("ws-bench", "../outside", {}, f.root), /无效/);
    const outside = join(f.base, "outside"); await mkdir(outside);
    await symlink(outside, join(f.workspace, "logs/linked"));
    await assert.rejects(benchmarkEvidence("ws-bench", "linked", {}, f.root), /运行目录/);
  } finally { await f.cleanup(); }
});

test("evidence resolves a bounded page and reports missing files without sealing bytes", async () => {
  const f = await fixture();
  try {
    const references: EvidenceReference[] = Array.from({ length: 27 }, (_, i) => ({ kind: "file", path: `evidence-${i}.txt` }));
    const trial = f.make("run-010", { evidence: references });
    const directory = await f.save(trial);
    for (let i = 0; i < 27; i++) if (i !== 25) await writeFile(join(directory, `evidence-${i}.txt`), i === 26 ? "changed" : `payload-${i}`);
    const first = await benchmarkEvidence("ws-bench", trial.id, {}, f.root);
    assert.equal(first.evidence.items.length, 25);
    assert.ok(first.evidence.items.every(item => item.available));
    assert.equal(first.evidence.nextCursor, "25");
    const second = await benchmarkEvidence("ws-bench", trial.id, { evidenceCursor: "25" }, f.root);
    assert.equal(second.evidence.items.length, 2);
    assert.deepEqual(second.evidence.items.map(item => item.available), [false, true]);
    assert.equal(second.evidence.nextCursor, undefined);
    await assert.rejects(benchmarkEvidence("ws-bench", trial.id, { evidenceCursor: "-1" }, f.root), /无效/);
    await assert.rejects(benchmarkEvidence("ws-bench", trial.id, {}, f.root, AbortSignal.abort()), /abort/i);
  } finally { await f.cleanup(); }
});

test("timeline gaps and escaping evidence remain unavailable without capturing replacements", async () => {
  const f = await fixture();
  try {
    const video = { pts: 100, timeBase: [1, 1000] as [number, number], width: 400, height: 240 };
    const references: EvidenceReference[] = [
      { kind: "timeline", timeline: { asset: "video/abc.mp4", video } },
      { kind: "timeline", timeline: { asset: "video/gap-abc.mp4", video: { ...video, status: "gap", reason: "encoder busy" } } },
      { kind: "timeline", timeline: { asset: "video/def.mp4", video } },
      { kind: "file", path: "escape" },
    ];
    const trial = f.make("run-010", { evidence: references });
    const directory = await f.save(trial), timeline = join(f.workspace, ".rsa/timeline");
    await mkdir(join(timeline, "video"), { recursive: true });
    await writeFile(join(timeline, "video/abc.mp4"), "fixture bytes");
    await json(join(timeline, "video/abc.mp4.json"), { status: "ready" });
    await json(join(timeline, "video/def.mp4.json"), { status: "writing" });
    await writeFile(join(f.base, "outside"), "outside");
    await symlink(join(f.base, "outside"), join(directory, "escape"));
    const proof = await benchmarkEvidence("ws-bench", trial.id, {}, f.root);
    assert.deepEqual(proof.evidence.items.map(item => item.available), [true, false, false, false]);
    assert.match(proof.evidence.items[1].error!, /Recording gap.*encoder busy/);
    assert.match(proof.evidence.items[2].error!, /not ready/);
    assert.match(proof.evidence.items[3].error!, /escapes/);
    await assert.rejects(access(join(timeline, "video/gap-abc.mp4")));
    await assert.rejects(access(join(timeline, "video/def.mp4")));
  } finally { await f.cleanup(); }
});

test("diagnostic attachments load only by registered index with a bounded text preview", async () => {
  const f = await fixture();
  try {
    const large = "x".repeat(300 * 1024), references: EvidenceReference[] = [
      { kind: "file", path: "details.json" },
      { kind: "file", path: "large.txt" },
      { kind: "file", path: "binary" },
    ];
    const trial = f.make("run-010", { evidence: references });
    const directory = await f.save(trial);
    await writeFile(join(directory, "details.json"), '{"check":false}');
    await writeFile(join(directory, "large.txt"), large);
    await writeFile(join(directory, "binary"), "a\0b");
    const preview = await benchmarkAttachment("ws-bench", trial.id, 0, undefined, f.root);
    assert.equal(preview.text, '{"check":false}'); assert.equal(preview.truncated, false);
    const truncated = await benchmarkAttachment("ws-bench", trial.id, 1, undefined, f.root);
    assert.equal(truncated.text.length, 256 * 1024); assert.equal(truncated.truncated, true);
    await assert.rejects(benchmarkAttachment("ws-bench", trial.id, 2, undefined, f.root), /二进制/);
    await assert.rejects(benchmarkAttachment("ws-bench", trial.id, 999, undefined, f.root), /引用/);
    await assert.rejects(benchmarkAttachment("ws-bench", trial.id, -1, undefined, f.root), /序号/);
    await writeFile(join(directory, "details.json"), "changed");
    assert.equal((await benchmarkAttachment("ws-bench", trial.id, 0, undefined, f.root)).text, "changed");
    assert.deepEqual(parseBenchmarkRequest(new URLSearchParams("project=ws-bench&run=run-010&attachment=1&verification=v1")), { kind: "attachment", project: "ws-bench", run: "run-010", index: 1, verification: "v1" });
    for (const query of ["attachment=0", "project=ws-bench&run=run-010&attachment=-1", "project=ws-bench&run=run-010&attachment=1.5"]) assert.throws(() => parseBenchmarkRequest(new URLSearchParams(query)));
  } finally { await f.cleanup(); }
});

test("selected verification diagnostics share the bounded attachment route with execution logs", async () => {
  const f = await fixture();
  try {
    const trial = f.make("run-010", { evidence: [{ kind: "file", path: "stdout.log" }, { kind: "file", path: "stderr.log" }] });
    const directory = await f.save(trial);
    await writeFile(join(directory, "stdout.log"), "execution stdout");
    await writeFile(join(directory, "stderr.log"), "execution stderr");
    for (const id of ["verify-010", "verify-011"]) {
      await f.verify(trial, id, { evidence: ["details.json", "stdout.log", "stderr.log"].map(name => ({ kind: "file", path: `verifier/${id}/${name}` })) });
      for (const name of ["details.json", "stdout.log", "stderr.log"]) await writeFile(join(directory, "verifier", id, name), `${id}:${name}`);
    }
    const proof = await benchmarkEvidence("ws-bench", trial.id, { verification: "verify-010" }, f.root);
    assert.equal(proof.evidence.items.length, 5);
    assert.ok(proof.evidence.items.every(item => item.available));
    for (const item of proof.evidence.items) {
      const attachment = await benchmarkAttachment("ws-bench", trial.id, item.index, "verify-010", f.root);
      assert.equal(attachment.text, item.index < 2 ? `execution ${item.index === 0 ? "stdout" : "stderr"}` : `verify-010:${["details.json", "stdout.log", "stderr.log"][item.index - 2]}`);
    }
    assert.equal((await benchmarkAttachment("ws-bench", trial.id, 2, "verify-011", f.root)).text, "verify-011:details.json");
  } finally { await f.cleanup(); }
});

test("evidence keeps source event identity distinct from a colliding run-local sequence", async () => {
  const f = await fixture();
  try {
    const references: EvidenceReference[] = [{ kind: "event", runId: "run-010", seq: 2 }, { kind: "event", runId: "run-010", eventId: "service:2" }, { kind: "event", runId: "run-010", eventId: "service:99" }];
    const trial = f.make("run-010", { evidence: references });
    const directory = await f.save(trial), source = join(f.base, "device-source");
    await mkdir(join(source, "events"), { recursive: true });
    await json(join(source, "source.json"), { sourceId: "service", format: "baseware-events-v1" });
    await writeFile(join(source, "events/2026-10-28-2.jsonl"), JSON.stringify({ seq: 2, at, atMs: Date.parse(at), type: "action_end", trace: { recordingId: trial.id, epoch: "first" }, data: { status: "completed" }, origin: { eventId: "service:2", clockId: "service", seq: 2 } }) + "\n");
    await json(join(directory, "manifest.json"), { kind: "benchmark", benchmark: trial.task, drivers: [], eventSources: [{ sourceId: "service", root: source, format: "baseware-events-v1", recordingId: trial.id, windows: [] }] });
    await writeFile(join(directory, "events.jsonl"), JSON.stringify({ seq: 2, at, type: "model_end", trace: { epoch: "first", modelCallId: "call" }, data: {} }) + "\n");
    const proof = await benchmarkEvidence("ws-bench", trial.id, {}, f.root);
    assert.deepEqual(proof.evidence.items.map(item => [item.available, item.event?.type]), [[true, "model_end"], [true, "action_end"], [false, undefined]]);
    assert.match(benchmarkRunUrl(trial, proof.evidence.items[0].event), /call=call/);
  } finally { await f.cleanup(); }
});

test("benchmark history does not replace a game run or Alice initial selection", async () => {
  const f = await fixture();
  try {
    await f.save(f.make("z-benchmark"));
    const directory = join(f.workspace, "logs/a-game"); await mkdir(directory);
    await json(join(directory, "manifest.json"), { model: "game-model", seconds: 1800, drivers: [] });
    clearCatalogCache();
    const projects = await catalog(f.root);
    assert.equal(latestGameRun(projects[0])?.id, "a-game");
    assert.deepEqual(initialSelection("", projects), { project: "ws-bench", run: "", epoch: "" });
    assert.equal(initialSelection("?project=ws-bench&run=z-benchmark", projects).run, "z-benchmark");
  } finally { await f.cleanup(); }
});

test("comparison retains verifier and conditions identity and labels a re-score as the same execution", async () => {
  const f = await fixture();
  try {
    const trial = f.make();
    const verification = await f.verify(trial);
    const baseline: BenchmarkResult = { trial, verification, verifier_result: { rewards: { quality: 0, latency: 10 } } };
    const result: BenchmarkResult = { trial: { ...trial, subjects: [{ id: "capability", revision: "v2" }] }, verification: { ...verification, id: "verify-011" }, verifier_result: { rewards: { quality: 1 } } };
    const comparison = compareResults(result, baseline);
    assert.equal(comparison.sameExecution, true);
    assert.equal(comparison.subjectsChanged, true);
    assert.deepEqual(comparison.verifications, { result: "verify-011", baseline: "verify-010" });
    assert.deepEqual(comparison.rewards, [{ key: "latency", value: null, baseline: 10, delta: null }, { key: "quality", value: 1, baseline: 0, delta: 1 }]);
    const changed = compareResults({ ...result, trial: { ...trial, conditions: { backend: "different" } } }, baseline);
    assert.deepEqual(changed.changes, ["conditions"]); assert.equal(changed.rewards.find(item => item.key === "quality")?.delta, 1);
    assert.ok(compareResults({ ...result, verification: null, verifier_result: { rewards: null } }, baseline).rewards.every(item => item.delta === null));
  } finally { await f.cleanup(); }
});

test("one-time legacy import preserves a fixed report link without a query-time legacy adapter", async () => {
  const f = await fixture();
  try {
    const runId = "legacy-run", directory = join(f.workspace, "logs", runId);
    await mkdir(join(directory, "reports"), { recursive: true });
    await json(join(directory, "manifest.json"), { kind: "benchmark", benchmark: { id: "legacy", revision: "1", protocolVersion: "1" }, drivers: [] });
    await json(join(directory, "benchmark.json"), { schemaVersion: 3, runId, project: "ws-bench", workspace: f.workspace, status: "completed", startedAt: at, endedAt: at,
      definition: { id: "legacy", revision: "1", protocolVersion: "1" } });
    const report = { schemaVersion: 1, id: "report-1", runId, createdAt: at, reason: "manual revision", previousReportId: null, protocolVersion: "1",
      outcome: { metrics: [{ id: "latency", value: 12 }], checks: [{ id: "goal", passed: false }] } };
    await json(join(directory, "reports/report-1.json"), report);
    const source = await readFile(join(directory, "reports/report-1.json"), "utf8");
    await importLegacyTrial(f.workspace, runId);
    clearCatalogCache();
    const request = parseBenchmarkRequest(new URLSearchParams(`project=ws-bench&run=${runId}&report=report-1`));
    assert.equal(request.kind, "detail"); if (request.kind !== "detail") return;
    const proof = await benchmarkEvidence(request.project, request.run, request.query, f.root);
    assert.equal(proof.result.verification?.id, "report-1");
    assert.deepEqual(proof.result.verifier_result.rewards, { latency: 12 });
    assert.equal(proof.result.trial.legacy?.originalId, "legacy");
    assert.ok(proof.evidence.items.some(item => item.reference.kind === "file" && item.reference.path === "reports/report-1.json" && item.available));
    assert.equal(await readFile(join(directory, "reports/report-1.json"), "utf8"), source);
    const list = await benchmarkCatalog({}, f.root, f.repository);
    assert.equal(list.history.trials[0].id, runId);
  } finally { await f.cleanup(); }
});

test("request and link helpers preserve explicit verification selections and reject ambiguous requests", async () => {
  const f = await fixture();
  try {
    const trial = f.make(); const verification = await f.verify(trial);
    const result: BenchmarkResult = { trial, verification, verifier_result: { rewards: {} } };
    assert.equal(resultKey(trial), "ws-bench/run-010");
    assert.deepEqual(parseResultKey(resultKey(trial)), { project: "ws-bench", run: "run-010" });
    assert.equal(parseResultKey("ws/../run"), null);
    assert.equal(benchmarkSelection(result, result).verification, "verify-010");
    assert.equal(benchmarkSelection(result, result).baselineVerification, "verify-010");
    assert.equal(benchmarkSelection(result).report, null);
    const task = { ...f.task, bindings: [{ path: "/workspace/it's here/run.json", configuration: { task: f.task.name, argv: ["program"] } }] };
    assert.match(benchmarkCommand(task, "/workspace/it's here")!, /'\\''/);
    assert.ok(benchmarkCommand(task, f.workspace)!.includes(`--digest '${f.task.digest}'`));
    assert.ok(benchmarkCommand(task, f.workspace)!.includes("--config "));
    assert.equal(benchmarkCommand({ ...task, bindings: [] }, f.workspace), null);
    const ambiguous = { ...task, bindings: [...task.bindings, { ...task.bindings[0], path: "/other.json" }] };
    assert.equal(benchmarkCommand(ambiguous, f.workspace), null);
    assert.ok(benchmarkCommand(ambiguous, f.workspace, "/other.json")!.endsWith("--config '/other.json'"));
    assert.match(benchmarkVerifyCommand(trial), /bench verify 'run-010'/);
    const parsed = parseBenchmarkRequest(new URLSearchParams("project=ws-bench&run=run-010&report=legacy-report"));
    assert.equal(parsed.kind, "detail"); if (parsed.kind === "detail") assert.equal(parsed.query.verification, "legacy-report");
    assert.deepEqual(parseBenchmarkRequest(new URLSearchParams("project=ws-bench&task=fixture%2Fcapability&limit=25&cursor=run-010")), { kind: "catalog", query: { project: "ws-bench", taskName: "fixture/capability", cursor: "run-010", limit: 25 } });
    for (const query of ["run=run-010", "report=report-1", "limit=0", "limit=101", "limit=1.5"]) assert.throws(() => parseBenchmarkRequest(new URLSearchParams(query)));
    const reference: EvidenceReference = { kind: "event", runId: "parent", eventId: "source:42" };
    assert.equal(evidenceLabel(reference), "parent · source:42");
    assert.match(benchmarkRunUrl(trial, { seq: 1, at, atMs: Date.parse(at), type: "action_end", data: {}, trace: { epoch: "e" } } as Event, reference), /run=parent/);
  } finally { await f.cleanup(); }
});
