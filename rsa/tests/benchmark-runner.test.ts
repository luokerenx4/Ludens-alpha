import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase } from "../src/benchmark/runner.ts";
import { compareResults, outcomeVerdict, validateOutcome } from "../src/benchmark/contract.ts";
import { history } from "../src/benchmark/store.ts";

test("built-in evaluations share workspace/history but isolate fixture work and online requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-bench-runner-"));
  const options = { artifactRoot: join(directory, "index"), workspace: join(directory, "workspace"),
    model: "intentionally-not-configured", seconds: 20, maxRequests: 5, seed: 7, live: false };
  try {
    const first = await runCase("control-handoff", options);
    const second = await runCase("control-handoff", options);
    expect(first.result.status).toBe("completed"); expect(first.result.verdict).toBe("passed");
    expect(second.result.verdict).toBe("passed");
    expect(first.runDir).not.toBe(second.runDir);
    expect(first.result.project).toBe(second.result.project);
    const index = JSON.parse(await readFile(join(options.artifactRoot, first.result.project, "workspace.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(first.runDir, "manifest.json"), "utf8"));
    expect(manifest.workspace).toBe(index.workspace);
    expect(manifest.kind).toBe("benchmark"); expect(manifest.benchmark.id).toBe("control-handoff");
    expect(first.runDir).toBe(join(index.workspace, "logs", first.result.runId));
    expect(await readdir(options.workspace)).not.toContain("handoff.py");
    const events = (await readFile(join(first.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events[0].type).toBe("benchmark_start"); expect(events.at(-1).type).toBe("benchmark_end");
    expect(events.at(-1).source.component).toBe("benchmark");
    expect(first.result.checks.every(check => check.evidenceSeq.every(seq => events.some(event => event.seq === seq)))).toBe(true);
    const skipped = await runCase("capability-reuse", options);
    expect(skipped.result.status).toBe("skipped"); expect(skipped.result.verdict).toBeNull();
    expect(await readdir(join(skipped.runDir, "work", "skills"))).toEqual([]);
    expect(await readdir(skipped.runDir)).not.toContain("benchmark-worker.log");
    const records = await history(options.workspace, "control-handoff");
    expect(records.results).toHaveLength(2); expect(records.issues).toEqual([]);
    const revised = { ...second.result, subjects: [{ id: "model", revision: "new" }] };
    expect(compareResults(revised, first.result)).toMatchObject({ compatible: true, subjectsChanged: true });
    expect(compareResults({ ...revised, conditions: { dataset: "changed" } }, first.result).changes).toContain("评测条件");
    expect(compareResults({ ...revised, metrics: [{ id: first.result.metrics[0]!.id, value: 1, unit: "seconds" }] }, first.result).metrics[0]?.delta).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("metrics-only completion, failed checks and missing evidence have distinct verdicts", () => {
  const check = { id: "check", label: "Check", expected: "evidence", actual: "none", evidenceSeq: [] };
  expect(outcomeVerdict({ checks: [], metrics: [] })).toBeNull();
  expect(outcomeVerdict({ checks: [{ ...check, passed: null }], metrics: [] })).toBe("inconclusive");
  expect(outcomeVerdict({ checks: [{ ...check, passed: false }], metrics: [] })).toBe("failed");
  expect(() => validateOutcome({ checks: [], metrics: [{ id: "latency", value: NaN, unit: "ms" }] })).toThrow();
});
