import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/harness/shiori-benchmark.ts";
test("offline packaged programs, verifiers and storage bindings share Shiori", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shiori-packaged-"))), workspace = join(root, "workspace");
  await mkdir(workspace);
  const sourceWorkspace = join(root, "source"), source = join(sourceWorkspace, "logs", "recorded-run");
  await mkdir(source, { recursive: true });
  const at = Date.now();
  const lines = Array.from({ length: 40 }, (_, index) => {
    const seq = index + 1, time = new Date(at + index * 100).toISOString();
    return JSON.stringify({ schemaVersion: 2, runId: "recorded-run", seq, at: time, atMs: index * 100, source: { component: "rsa" },
      origin: { eventId: `recorded-run:${seq}`, clockId: "recorded-run", seq, at: time, atMs: index * 100 },
      trace: { epoch: "recorded-epoch" }, type: "control", data: { mode: index % 2 ? "manual" : "auto", reason: "fixture" } });
  }).join("\n") + "\n";
  await writeFile(join(source, "events.jsonl"), lines);
  await writeFile(join(source, "manifest.json"), JSON.stringify({ runId: "recorded-run", workspace: sourceWorkspace }));
  try {
    for (const [name, parameters] of [
      ["perception-lifecycle", {}], ["ws-recovery", {}], ["background-compaction", {}],
      ["clamp", { samples: 30 }], ["video-storage", { records: 12, rate: 30 }], ["index-memory", { run: source }],
    ] as const) {
      const result = await runTask(`ludens/${name}`, { workspace, artifactRoot: join(root, "index"), seconds: 60, parameters });
      if (result.trial.status !== "completed") throw new Error(`${name}: ${await readFile(join(workspace, "logs", result.trial.id, "stderr.log"), "utf8")}`);
      expect({ name, status: result.trial.status, error: result.trial.error, verification: result.verification?.status,
        scoringError: result.verification?.error }).toEqual({ name, status: "completed", error: undefined, verification: "completed", scoringError: undefined });
      expect(Object.keys(result.verifier_result.rewards!).length).toBeGreaterThan(0);
    }
    expect(await readFile(join(source, "events.jsonl"), "utf8")).toBe(lines);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
