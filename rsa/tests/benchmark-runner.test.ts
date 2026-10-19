import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomeStatus, runCase } from "../src/benchmark/runner.ts";

test("runner isolates repeat runs, indexes original logs, and skips online work unless selected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-bench-runner-"));
  const options = { artifactRoot: join(directory, "index"), output: join(directory, "output"),
    model: "intentionally-not-configured", seconds: 20, maxRequests: 5, seed: 7, live: false };
  try {
    const first = await runCase("control-handoff", options);
    const second = await runCase("control-handoff", options);
    expect(first.result.status).toBe("passed"); expect(second.result.status).toBe("passed");
    expect(first.runDir).not.toBe(second.runDir);
    expect(first.result.project).not.toBe(second.result.project);
    const index = JSON.parse(await readFile(join(options.artifactRoot, first.result.project, "workspace.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(first.runDir, "manifest.json"), "utf8"));
    expect(manifest.workspace).toBe(index.workspace);
    expect(manifest.benchmark.caseId).toBe("control-handoff");
    const events = (await readFile(join(first.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events[0].type).toBe("benchmark_start");
    expect(events.at(-1).type).toBe("benchmark_end");
    expect(events.at(-1).source.component).toBe("benchmark");
    expect(first.result.checks.every(check => check.evidenceSeq.every(seq => events.some(event => event.seq === seq)))).toBe(true);
    const skipped = await runCase("capability-reuse", options);
    expect(skipped.result.status).toBe("skipped");
    expect(skipped.result.checks).toEqual([]);
    expect(await readdir(join(skipped.runDir, "..", "..", "skills"))).toEqual([]);
    expect(await readdir(skipped.runDir)).not.toContain("benchmark-worker.log");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("missing evidence or a failed check cannot become a pass", () => {
  const check = { id: "check", label: "Check", expected: "evidence", actual: "none", evidenceSeq: [] };
  expect(outcomeStatus({ checks: [], metrics: [] })).toBe("inconclusive");
  expect(outcomeStatus({ checks: [{ ...check, passed: null }], metrics: [] })).toBe("inconclusive");
  expect(outcomeStatus({ checks: [{ ...check, passed: true }, { ...check, passed: false }], metrics: [] })).toBe("failed");
});
