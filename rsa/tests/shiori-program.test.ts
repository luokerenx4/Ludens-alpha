import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/harness/runtime.ts";
import { runTask, verifyTask } from "../src/harness/shiori-benchmark.ts";

test("a completed program cannot leave a background process holding output pipes and consuming the remaining budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-pipes-"));
  const runtime = new Runtime(undefined, () => {}, 3);
  try {
    const started = performance.now();
    await runtime.runProgram({ argv: ["/bin/sh", "-c", "sleep 60 & exit 0"], cwd: root, env: process.env,
      stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, agent: false });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("program budget cancellation drains a process that ignores TERM and leaves the Runtime reusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-timeout-"));
  const runtime = new Runtime(undefined, () => {}, 0.1);
  const output = { cwd: root, env: process.env, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") };
  try {
    await expect(runtime.runProgram({ ...output, argv: ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"] })).rejects.toThrow();
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, reason: "time budget" });
    await runtime.runProgram({ ...output, argv: ["/bin/sh", "-c", "exit 0"] });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);

test("invalid verifier budget is rejected before a pending verification can be created", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-verify-budget-")), workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const result = await runTask("ludens/clamp", { workspace, artifactRoot: join(root, "index"), parameters: { samples: 10 }, verify: false });
    expect(result.trial.status).toBe("completed");
    const task = join(workspace, "benchmarks/tasks/clamp");
    await mkdir(join(task, "tests"), { recursive: true }); await mkdir(join(task, "environment"));
    await writeFile(join(task, "task.toml"), 'schema_version="1.4"\n[task]\nname="ludens/clamp"\n[verifier]\ntimeout_sec=2147483647\n');
    await writeFile(join(task, "instruction.md"), "Score fixed evidence"); await writeFile(join(task, "tests/test.sh"), "exit 0\n");
    await expect(verifyTask(workspace, result.trial.id, { taskPath: task })).rejects.toThrow("budget");
    expect(await readdir(join(workspace, "logs", result.trial.id, "verifier")).catch(() => [])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 5000);
