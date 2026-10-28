import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareResults, validateRewards, type Trial, type Verification } from "../src/benchmark/contract.ts";
import { discoverTasks } from "../src/benchmark/catalog.ts";
import { datasetDigest, meanRewards, prepareMetricInput, readDataset } from "../src/benchmark/dataset.ts";
import { importLegacyTrial } from "../src/benchmark/legacy-import.ts";
import { readReward } from "../src/benchmark/reward.ts";
import { createTrial, createVerification, finishTrial, finishVerification, get, history, inspectEvidence, readTrial, verifications } from "../src/benchmark/store.ts";
import { hashFile, pinTask, readTask, taskDigest } from "../src/benchmark/task.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-task-contract-"))); roots.push(root); return root; }
async function file(path: string, data: string) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, data); }
const identity = { name: "ludens/test", digest: `sha256:${"1".repeat(64)}` };
async function task(root: string, extra = "") {
  await file(join(root, "task.toml"), `schema_version = "1.4"\n[task]\nname = "ludens/test"\nversion = "1.2"\ndescription = "Test package"\n${extra}`);
  await file(join(root, "instruction.md"), "Measure the fixture.\n");
  await file(join(root, "environment/data.txt"), "fixture\n");
  await file(join(root, "tests/test.sh"), "#!/bin/sh\nexit 0\n");
  return root;
}
function trial(workspace: string, id = "2026-10-28T01-00-00.000Z"): Trial {
  return { schemaVersion: 1, id, runId: id, workspace, project: "ws-test", task: identity, status: "running", startedAt: "2026-10-28T01:00:00Z", parameters: {}, conditions: { fixture: "a" }, subjects: [], evidence: [] };
}
function verification(trialId: string, id: string): Verification {
  return { schemaVersion: 1, id, trialId, task: identity, status: "running", startedAt: "2026-10-28T01:01:00Z", reason: "initial", evidence: [] };
}
async function completed(workspace: string, id?: string) {
  const value = trial(workspace, id); await createTrial(workspace, value);
  return (await finishTrial(workspace, value.id, { status: "completed", endedAt: "2026-10-28T01:01:00Z", durationMs: 60_000 })).trial;
}

test("Harbor Task 1.4 digest selects standard paths, applies ignore and pins immutable bytes", async () => {
  const root = await temporary(), path = await task(join(root, "author"));
  await file(join(path, "not-part-of-task.txt"), "ignored root file");
  await file(join(path, "tests/.harborignore"), "secret.txt\nsub/*.tmp\n");
  await file(join(path, "tests/secret.txt"), "hidden");
  await file(join(path, "tests/sub/ok.txt"), "included");
  await file(join(path, "tests/sub/no.tmp"), "hidden");
  await file(join(path, "environment/__pycache__/x.pyc"), "hidden default");
  const found = await readTask(path);
  const selected = await taskDigest(path);
  expect(selected.files).toEqual(["environment/data.txt", "instruction.md", "task.toml", "tests/sub/ok.txt", "tests/test.sh"]);
  const material = await Promise.all(selected.files.map(async name => `${name}\0${createHash("sha256").update(await readFile(join(path, name))).digest("hex")}\n`));
  expect(found.digest).toBe(`sha256:${createHash("sha256").update(material.join("")).digest("hex")}`);
  const pinned = await pinTask(root, found);
  expect(pinned.digest).toBe(found.digest);
  await writeFile(join(path, "environment/data.txt"), "changed author bytes");
  expect((await readTask(pinned.path)).digest).toBe(found.digest);
  await expect(pinTask(root, { ...found, digest: (await readTask(path)).digest })).resolves.toHaveProperty("name", found.name);
});

test("root gitignore replaces defaults; excluded required files and escaping symlinks fail", async () => {
  const root = await temporary(), path = await task(join(root, "author"));
  await file(join(path, ".gitignore"), "environment/skip\n");
  await file(join(path, "environment/cache.pyc"), "included with explicit gitignore");
  expect((await taskDigest(path)).files).toContain("environment/cache.pyc");
  await file(join(path, "tests/.harborignore"), "test.sh\n");
  await expect(readTask(path)).rejects.toThrow("required task input");
  await rm(join(path, "tests/.harborignore"));
  await file(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(path, "environment/link.txt"));
  await expect(taskDigest(path)).rejects.toThrow("escapes");
});

test("discovery is file-only and native profile exposes unsupported requirements", async () => {
  const root = await temporary();
  const path = await task(join(root, "benchmarks/tasks/test"), '[environment]\ncpus = 2\nnetwork_mode = "no-network"\n');
  await file(join(path, "environment/do-not-run.py"), "raise RuntimeError('must not import')");
  const found = await discoverTasks(root, join(root, "empty-repository"));
  expect(found.tasks).toHaveLength(1);
  expect(found.diagnostics).toEqual([]);
  expect(found.tasks[0]!.unsupportedRequirements).toEqual(["environment.cpus", "environment.network_mode=no-network (no native network isolation)"]);
  await file(join(path, "task.toml"), 'version = "1.0"\n[task]\nname = "ludens/test"');
  expect((await discoverTasks(root, join(root, "empty-repository"))).diagnostics[0]!.message).toContain("1.4");
});

test("reward JSON wins, zero is valid, null/nested/bool/nonfinite are not rewards", async () => {
  const root = await temporary();
  await file(join(root, "reward.txt"), "1\n");
  expect(await readReward(root)).toEqual({ reward: 1 });
  await file(join(root, "reward.json"), '{"accuracy":0,"latency_ms":2.5}');
  expect(await readReward(root)).toEqual({ accuracy: 0, latency_ms: 2.5 });
  await file(join(root, "reward.json"), "null");
  await expect(readReward(root)).rejects.toThrow("flat object");
  for (const value of [null, { value: true }, { value: {} }, { value: Infinity }, { value: NaN }]) expect(() => validateRewards(value)).toThrow();
  expect(() => validateRewards({})).not.toThrow();
});

test("one terminal CAS, verification selected after reward commit, failure never reuses prior score", async () => {
  const root = await temporary(), value = trial(root); await createTrial(root, value);
  const finishes = await Promise.all([
    finishTrial(root, value.id, { status: "completed", endedAt: "2026-10-28T01:01:00Z", durationMs: 60_000 }),
    finishTrial(root, value.id, { status: "cancelled", endedAt: "2026-10-28T01:01:01Z", durationMs: 61_000 }),
  ]);
  expect(finishes.filter(result => result.changed)).toHaveLength(1);
  const v1 = await createVerification(root, value.id, verification(value.id, "v1"));
  expect((await get(root, value.id)).verification).toBeNull();
  await expect(finishVerification(root, value.id, "v1", { status: "completed", endedAt: "2026-10-28T01:01:02Z" })).rejects.toThrow("Missing verifier reward");
  expect((await readTrial(root, value.id)).selectedVerificationId).toBeUndefined();
  await file(join(v1.directory, "reward.json"), '{"reward":0}');
  const result = await finishVerification(root, value.id, "v1", { status: "completed", endedAt: "2026-10-28T01:01:02Z" });
  expect(result.changed).toBe(true); expect((await get(root, value.id)).verifier_result.rewards).toEqual({ reward: 0 });
  await createVerification(root, value.id, verification(value.id, "v2"));
  await finishVerification(root, value.id, "v2", { status: "error", endedAt: "2026-10-28T01:01:03Z", error: { code: "VERIFIER_ERROR", message: "failed" } });
  expect((await get(root, value.id)).verifier_result.rewards).toBeNull();
  expect((await get(root, value.id, "v1")).verifier_result.rewards).toEqual({ reward: 0 });
  expect((await verifications(root, value.id, { limit: 1 })).nextCursor).toBe("v2");
  expect((await finishVerification(root, value.id, "v2", { status: "completed", endedAt: "later" })).changed).toBe(false);
});

test("history is paginated compact summaries and never opens verifier outputs", async () => {
  const root = await temporary();
  for (const id of ["run1", "run2", "run3"]) {
    await completed(root, id);
    await file(join(root, "logs", id, "verifier/broken/verification.json"), "not JSON");
  }
  const page = await history(root, { limit: 2 });
  expect(page.trials.map(item => item.id)).toEqual(["run3", "run2"]);
  expect(page.nextCursor).toBe("run2");
  expect((await history(root, { limit: 2, cursor: page.nextCursor })).trials.map(item => item.id)).toEqual(["run1"]);
  expect("conditions" in page.trials[0]!).toBe(false);
});

test("fixed file/prefix and timeline evidence detect edits, missing originals and pending encoding", async () => {
  const root = await temporary(), value = await completed(root);
  const path = join(root, "logs", value.id, "artifacts/data.json"); await file(path, '{"value":1}');
  const ref = { kind: "file" as const, path: "artifacts/data.json", sha256: await hashFile(path) };
  expect((await inspectEvidence(root, value.id, ref)).available).toBe(true);
  await writeFile(path, '{"value":2}'); expect((await inspectEvidence(root, value.id, ref)).available).toBe(false);
  const event = JSON.stringify({ seq: 1, origin: { eventId: "local:1" }, type: "measured" }) + "\n";
  const log = join(root, "logs", value.id, "events.jsonl"); await file(log, event + '{"seq":2}\n');
  const prefix = { kind: "event" as const, runId: value.id, path: "events.jsonl", byteLength: Buffer.byteLength(event), sha256: await hashFile(log, Buffer.byteLength(event)) };
  expect((await inspectEvidence(root, value.id, prefix)).available).toBe(true);
  const timeline = { asset: "video/aaaaaaaa.mp4", video: { pts: 0, timeBase: [1, 30] as [number, number], width: 4, height: 4 } };
  await file(join(root, ".rsa/timeline/video/aaaaaaaa.mp4"), "recorded");
  await file(join(root, ".rsa/timeline/video/aaaaaaaa.mp4.json"), '{"status":"pending"}');
  expect((await inspectEvidence(root, value.id, { kind: "timeline", timeline })).available).toBe(false);
  await file(join(root, ".rsa/timeline/video/aaaaaaaa.mp4.json"), '{"status":"ready"}');
  expect((await inspectEvidence(root, value.id, { kind: "timeline", timeline })).available).toBe(true);
});

test("dataset standard digest and metric rows preserve null, policy and independent-trial count", async () => {
  const root = await temporary(), value = await completed(root), result = await get(root, value.id);
  await file(join(root, "metric.py"), "print('metric')\n");
  await file(join(root, "dataset.toml"), `[dataset]\nname="ludens/fixtures"\n[[tasks]]\nname="${identity.name}"\ndigest="${identity.digest}"\n[[files]]\npath="metric.py"\n`);
  const dataset = await readDataset(join(root, "dataset.toml"));
  expect(dataset.digest).toBe(datasetDigest(dataset.tasks, dataset.files));
  const input = prepareMetricInput(dataset, [result]);
  expect(input.input).toBe("null\n"); expect(input.counts).toEqual({ trials: 1, included: 1, valid: 0, executionErrors: 0, verificationErrors: 1 });
  expect(prepareMetricInput(dataset, [result], "graded").excluded).toHaveLength(1);
  expect(() => prepareMetricInput(dataset, [result, result])).toThrow("Duplicate trial");
  expect(meanRewards([{ value: 6 }, null, {}])).toEqual({ mean: 2 });
  expect(meanRewards([null, {}])).toEqual({ mean: 0 });
  expect(meanRewards([{ a: 6 }, { b: 4 }])).toEqual({ a: 3, b: 2 });
  expect(() => meanRewards([])).toThrow("at least one trial");
  await file(join(root, "metric.py"), "changed");
  expect((await readDataset(join(root, "dataset.toml"))).digest).not.toBe(dataset.digest);
});

test("comparison fixes task/verifier and conditions, subject candidate may change", async () => {
  const root = await temporary(), value = await completed(root), v = await createVerification(root, value.id, verification(value.id, "v1"));
  await file(join(v.directory, "reward.json"), '{"correct":1}');
  await finishVerification(root, value.id, "v1", { status: "completed", endedAt: "2026-10-28T01:01:02Z" });
  const result = await get(root, value.id), baseline = structuredClone(result);
  baseline.trial.subjects = [{ id: "model", revision: "old" }]; baseline.verifier_result.rewards = { correct: 0 };
  expect(compareResults(result, baseline)).toMatchObject({ compatible: true, subjectsChanged: true, rewards: [{ key: "correct", value: 1, baseline: 0, delta: 1 }] });
  baseline.trial.conditions = { fixture: "other" };
  expect(compareResults(result, baseline).compatible).toBe(false);
  expect(compareResults(result, baseline).rewards[0]!.delta).toBeNull();
});

test("legacy is explicit one-time import, fixed report links and diagnostic unknown checks survive", async () => {
  const root = await temporary(), id = "legacy-run", run = join(root, "logs", id);
  const old = { schemaVersion: 3, runId: id, workspace: root, project: "ws-old", status: "completed", startedAt: "2026-10-27T00:00:00Z", endedAt: "2026-10-27T00:01:00Z", durationMs: 60_000, definition: { id: "old-check", protocolVersion: "1" }, parameters: {}, conditions: {}, subjects: [] };
  await file(join(run, "benchmark.json"), JSON.stringify(old));
  await file(join(run, "reports/r1.json"), JSON.stringify({ schemaVersion: 1, id: "r1", runId: id, createdAt: old.endedAt, protocolVersion: "1", previousReportId: null, reason: "initial", outcome: { checks: [{ id: "unknown", passed: null }], metrics: [{ id: "latency", value: 2 }, { id: "missing", value: null }] } }));
  expect((await history(root)).trials).toEqual([]);
  expect((await importLegacyTrial(root, id)).imported).toBe(true);
  const result = await get(root, id, "r1");
  expect(result.verifier_result.rewards).toEqual({ latency: 2 });
  expect(result.verification?.legacy?.originalId).toBe("r1");
  expect(JSON.parse(await readFile(join(run, "reports/r1.json"), "utf8")).outcome.checks[0].passed).toBeNull();
  expect((await importLegacyTrial(root, id)).imported).toBe(false);
});


test("publisher root negation semantics and case-sensitive paths match Harbor", async () => {
  const root = await temporary(), path = await task(join(root, "task"));
  await file(join(path, "environment/dir/keep.txt"), "keep");
  await file(join(path, "environment/dir/drop.txt"), "drop");
  await file(join(path, "environment/Case.txt"), "case");
  await file(join(path, ".gitignore"), "environment/dir/\n!environment/dir/keep.txt\nenvironment/case.txt\n");
  const { files } = await taskDigest(path);
  expect(files).toContain("environment/dir/keep.txt");
  expect(files).toContain("environment/Case.txt");
  expect(files).not.toContain("environment/dir/drop.txt");
});

test("sealed reward mutations fail instead of changing a fixed verification's score", async () => {
  const root = await temporary(), value = await completed(root);
  const { directory } = await createVerification(root, value.id, verification(value.id, "v1"));
  await file(join(directory, "reward.json"), '{"reward":1}');
  await finishVerification(root, value.id, "v1", { status: "completed", endedAt: "2026-10-28T01:01:02Z" });
  await file(join(directory, "reward.json"), '{"reward":9}');
  await expect(get(root, value.id)).rejects.toThrow("Sealed verifier reward changed");
});


test("isolated child timeline references retain their owner without copying originals", async () => {
  const root = await temporary(), value = await completed(root);
  const workspaceRelative = `logs/${value.id}/work`;
  const timeline = { asset: "video/bbbbbbbb.mp4", video: { pts: 1, timeBase: [1, 30] as [number, number], width: 4, height: 4 } };
  const original = join(root, workspaceRelative, ".rsa/timeline", timeline.asset);
  await file(original, "isolated original");
  await file(original + ".json", '{"status":"ready"}');
  const reference = { kind: "timeline" as const, workspaceRelative, timeline, sha256: await hashFile(original) };
  expect(await inspectEvidence(root, value.id, reference)).toMatchObject({ available: true, path: original });
  expect((await inspectEvidence(root, value.id, { ...reference, workspaceRelative: ".." })).available).toBe(false);
  expect((await inspectEvidence(root, value.id, { ...reference, workspaceRelative: undefined })).available).toBe(false);
  const outside = await temporary(); await symlink(outside, join(root, "outside-owner"));
  expect((await inspectEvidence(root, value.id, { ...reference, workspaceRelative: "outside-owner" })).available).toBe(false);
});
