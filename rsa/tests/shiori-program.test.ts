import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    const result = await runTask("ludens/clamp", { workspace, globalHome: join(root, "index"), parameters: { samples: 10 }, verify: false });
    expect(result.trial.status).toBe("completed");
    const task = join(workspace, "benchmarks/tasks/clamp");
    await mkdir(join(task, "tests"), { recursive: true }); await mkdir(join(task, "environment"));
    await writeFile(join(task, "task.toml"), 'schema_version="1.4"\n[task]\nname="ludens/clamp"\n[verifier]\ntimeout_sec=2147483647\n');
    await writeFile(join(task, "instruction.md"), "Score fixed evidence"); await writeFile(join(task, "tests/test.sh"), "exit 0\n");
    await expect(verifyTask(workspace, result.trial.id, { taskPath: task })).rejects.toThrow("budget");
    expect(await readdir(join(workspace, "logs", result.trial.id, "verifier")).catch(() => [])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 5000);

// These integration tests exercise actual cross-process deadlines, signals and OS reaping;
// fake timers in the test process cannot drive the child Runtime or process-group cleanup.
async function budgetFixture(mode: "cooperative" | "blocked" | "failed" | "initializing") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shiori-shared-budget-")));
  const workspace = join(root, "workspace"), task = join(workspace, "benchmarks/tasks/budget");
  await mkdir(join(task, "tests"), { recursive: true }); await mkdir(join(task, "environment"));
  await writeFile(join(task, "instruction.md"), "Collect the final saved measurement after control ends.");
  await writeFile(join(task, "tests/test.sh"), '"$BUN" "$RSA_BENCH_TASK_DIR/tests/verify.ts"\n');
  await writeFile(join(task, "tests/verify.ts"), `
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const facts = JSON.parse(await readFile(join(process.env.RSA_BENCH_ARTIFACTS!, "measurements.json"), "utf8"));
    if (!facts.budgetEnded || facts.cancelled || facts.releases !== 1 || facts.saved !== "final measurement") throw new Error("Incomplete measurements");
    await writeFile(join(process.env.RSA_BENCH_VERIFIER_DIR!, "reward.json"), JSON.stringify({ saved: 1 }));
  `);
  // The Task controls its verifier environment; the module remains an ordinary bound program.
  await writeFile(join(task, "task.toml"), 'schema_version="1.4"\n[task]\nname="local/budget"\n[verifier]\ntimeout_sec=5\n[verifier.env]\nBUN=' + JSON.stringify(process.execPath) + '\n');
  const program = join(workspace, "program.ts"), ready = join(workspace, "ready.json");
  await writeFile(program, `
    import { spawn } from "node:child_process";
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { createHostRuntime } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/host.ts"))};
    import { initializeWorkspaceState } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/workspace-state.ts"))};
    import { createTestDeviceSession } from ${JSON.stringify(resolve(import.meta.dir, "runtime-fixture.ts"))};
    import type { BenchmarkContext } from ${JSON.stringify(resolve(import.meta.dir, "../src/benchmark/types.ts"))};
    const mode = ${JSON.stringify(mode)};
    if (mode === "initializing") {
      await writeFile(${JSON.stringify(ready)}, "{}");
      await Promise.withResolvers<void>().promise;
    }
    export async function run(ctx: BenchmarkContext) {
      const descendant = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
      if (mode !== "cooperative") {
        await writeFile(${JSON.stringify(ready)}, JSON.stringify({ pid: descendant.pid }));
        if (mode === "failed") throw new Error("deliberate program failure");
        await Promise.withResolvers<void>().promise;
      }
      const { devices } = createTestDeviceSession({ controllers: [] });
      let releases = 0;
      const release = devices.release.bind(devices);
      devices.release = async epoch => { releases++; await release(epoch); };
      const state = await initializeWorkspaceState(ctx.workspace);
      const runtime = await createHostRuntime({ devices, workspace: ctx.workspace, runDir: ctx.runDir, state,
        log: ctx.log, rsaSocket: "", basewareSocket: "", seconds: ctx.seconds / 10, budget: ctx.budget,
        maxRequests: 1, action: false });
      const finished = Promise.withResolvers<void>();
      runtime.agent = {
        async run({ signal }) {
          const stopped = Promise.withResolvers<void>();
          if (signal.aborted) stopped.resolve(); else signal.addEventListener("abort", () => stopped.resolve(), { once: true });
          await stopped.promise;
          await writeFile(join(ctx.workspace, "saved.txt"), "final measurement");
          finished.resolve();
        },
        async consolidate() {}, async abort() {}, async close() {},
      };
      const cancel = () => { void runtime.stop("cancelled"); };
      ctx.signal?.addEventListener("abort", cancel, { once: true });
      try {
        await runtime.start();
        if (ctx.signal?.aborted) cancel();
        await writeFile(${JSON.stringify(ready)}, JSON.stringify({ pid: descendant.pid }));
        await finished.promise;
      } finally {
        ctx.signal?.removeEventListener("abort", cancel);
        await runtime.close();
      }
      const saved = await readFile(join(ctx.workspace, "saved.txt"), { encoding: "utf8", signal: ctx.signal });
      return { saved, releases, budgetEnded: ctx.budget.signal.aborted, cancelled: ctx.signal?.aborted,
        reason: runtime.status().reason, descendant: descendant.pid };
    }
  `);
  return { root, workspace, ready, options: { workspace, globalHome: join(root, "index"),
    seconds: 1, config: { task: "local/budget", argv: [process.execPath, resolve(import.meta.dir, "../src/harness/module-program.ts"), program] } } };
}

async function waitForReady(path: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const content = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (content) return JSON.parse(content) as { pid?: number };
    if (Date.now() >= deadline) throw new Error("Fixture did not reach its work boundary");
    await Bun.sleep(10);
  }
}

async function expectProcessGone(pid: number) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); return; }
    if (Date.now() >= deadline) throw new Error(`Descendant ${pid} survived its program`);
    await Bun.sleep(10);
  }
}

test("outer budget stops a nested Host and still saves measurements and completes the verifier", async () => {
  const f = await budgetFixture("cooperative");
  try {
    const result = await runTask("local/budget", f.options);
    if (result.trial.status !== "completed") throw new Error(JSON.stringify({ error: result.trial.error,
      stderr: await readFile(join(f.workspace, "logs", result.trial.id, "stderr.log"), "utf8") }));
    expect(result.verification?.status).toBe("completed");
    expect(result.verifier_result.rewards).toEqual({ saved: 1 });
    const facts = JSON.parse(await readFile(join(f.workspace, "logs", result.trial.id, "artifacts/measurements.json"), "utf8"));
    expect(facts).toMatchObject({ reason: "time budget", budgetEnded: true, cancelled: false, releases: 1, saved: "final measurement" });
    await expectProcessGone(facts.descendant);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 10_000);

test("user cancellation of the same nested Host stays cancelled and never starts its verifier", async () => {
  const f = await budgetFixture("cooperative"), cancellation = new AbortController();
  const running = runTask("local/budget", { ...f.options, seconds: 30, signal: cancellation.signal });
  try {
    const { pid } = await waitForReady(f.ready);
    cancellation.abort(new Error("user cancelled"));
    const result = await running;
    expect(result.trial.status).toBe("cancelled");
    expect(result.verification).toBeNull();
    expect(await readdir(join(f.workspace, "logs", result.trial.id, "verifier")).catch(() => [])).toEqual([]);
    await expectProcessGone(pid!);
  } finally { cancellation.abort(); await running; await rm(f.root, { recursive: true, force: true }); }
}, 10_000);

for (const mode of ["blocked", "failed", "initializing"] as const) {
  test(`${mode} module remains an error and cannot retain descendants after the outer budget`, async () => {
    const f = await budgetFixture(mode);
    try {
      const result = await runTask("local/budget", f.options);
      expect(result.trial.status).toBe("error");
      expect(result.verification).toBeNull();
      const { pid } = await waitForReady(f.ready);
      if (pid) await expectProcessGone(pid);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 10_000);
}

test("an ordinary program that handles timeout with exit zero is still an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-zero-timeout-"));
  const runtime = new Runtime(undefined, () => {}, 0.1);
  try {
    await expect(runtime.runProgram({ argv: ["/bin/sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
      cwd: root, env: process.env, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") })).rejects.toBeDefined();
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);
