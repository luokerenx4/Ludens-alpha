import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runTask, verifyTask, aggregateTasks } from "../src/harness/shiori-benchmark.ts";
import { get, history } from "../src/benchmark/store.ts";
import { compareResults } from "../src/benchmark/contract.ts";
import { readTask } from "../src/benchmark/task.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shiori-benchmark-")), workspace = join(root, "workspace"), task = join(workspace, "benchmarks/tasks/jump");
  await mkdir(join(task, "tests"), { recursive: true }); await mkdir(join(task, "environment"));
  await writeFile(join(task, "task.toml"), 'schema_version="1.4"\n[task]\nname="local/jump"\n');
  await writeFile(join(task, "instruction.md"), "Make one synthetic jump; measure it.\n");
  const verifier = join(task, "tests/test.sh");
  await writeFile(verifier, 'printf \'{"height":24,"landed":0}\' > "$RSA_BENCH_VERIFIER_DIR/reward.json"\n');
  const program = join(workspace, "jump.py");
  await writeFile(program, `import os
from pathlib import Path
assert not os.environ.get("RSA_SOCKET")
assert not os.environ.get("BASEWARE_SOCKET")
assert not os.environ.get("OPENAI_API_KEY")
actions=Path("actions.txt")
actions.write_text(str(int(actions.read_text())+1) if actions.exists() else "1")
Path(os.environ["RSA_BENCH_ARTIFACTS"],"measurements.json").write_text('{"height":24}')
`);
  return { root, workspace, task, program, verifier, options: { workspace, artifactRoot: join(root, "index"), seconds: 5,
    config: { task: "local/jump", argv: ["{python}", program] } }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("CLI uses separate binding; reward zero, offline reads and verification never repeat actions", async () => {
  const f = await fixture(), cli = resolve(import.meta.dir, "../src/benchmark/cli.ts"), binding = join(f.root, "run.json");
  await writeFile(binding, JSON.stringify(f.options.config));
  const command = async (args: string[], code = 0) => {
    const child = Bun.spawn([process.execPath, "-e", `import {benchmarkCommand} from ${JSON.stringify(cli)}; await benchmarkCommand(${JSON.stringify(args)},${JSON.stringify(f.options.artifactRoot)},${JSON.stringify(f.workspace)});`], { stdout: "pipe", stderr: "pipe" });
    const [actual, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: actual, stderr: err }).toEqual({ code, stderr: "" }); return JSON.parse(out);
  };
  try {
    expect((await command(["list"])).tasks.some((t: any) => t.name === "local/jump")).toBe(true);
    const first = await command(["run", "local/jump", "--config", binding]);
    expect(first.trial.status).toBe("completed"); expect(first.verifier_result.rewards.landed).toBe(0); expect(first).not.toHaveProperty("verdict");
    const id = first.trial.id;
    await writeFile(f.program, "raise RuntimeError('must not execute on verification')\n");
    const second = await command(["verify", id]);
    expect(second.verification.id).not.toBe(first.verification.id);
    expect((await command(["get", `${id}@${first.verification.id}`])).verifier_result.rewards.height).toBe(24);
    expect((await command(["history", "local/jump", "--limit", "1"])).trials).toHaveLength(1);
    expect((await command(["verifications", id])).verifications).toHaveLength(2);
    expect((await command(["compare", `${id}@${first.verification.id}`, `${id}@${second.verification.id}`])).sameExecution).toBe(true);
    expect(await readFile(join(f.workspace, "actions.txt"), "utf8")).toBe("1");
  } finally { await f.cleanup(); }
}, 20_000);
test("invalid score is separate from execution; a new verifier regrades fixed evidence and detects tampering", async () => {
  const f = await fixture();
  try {
    await writeFile(f.verifier, 'printf \'{"height":null}\' > "$RSA_BENCH_VERIFIER_DIR/reward.json"\n');
    const first = await runTask("local/jump", f.options);
    expect(first.trial.status).toBe("completed"); expect(first.verification?.status).toBe("error");
    const execution = JSON.stringify({ ...first.trial, selectedVerificationId: undefined });
    await writeFile(f.program, "raise ImportError('evaluator is gone')\n");
    await writeFile(f.verifier, 'printf \'{"height":24}\' > "$RSA_BENCH_VERIFIER_DIR/reward.json"\n');
    const second = await verifyTask(f.workspace, first.trial.id, { taskPath: f.task, reason: "corrected verifier" });
    expect(second.verifier_result.rewards).toEqual({ height: 24 });
    expect(JSON.stringify({ ...second.trial, selectedVerificationId: undefined })).toBe(execution);
    expect(second.verification?.task.digest).not.toBe(first.verification?.task.digest);
    expect((await get(f.workspace, first.trial.id, first.verification!.id)).verifier_result.rewards).toBeNull();
    expect(compareResults(second, first).changes).toContain("verifier");
    expect(await readFile(join(f.workspace, "actions.txt"), "utf8")).toBe("1");
    expect((await history(f.workspace)).trials).toHaveLength(1);
    await writeFile(join(f.workspace, "logs", first.trial.id, "artifacts/measurements.json"), '{"height":99}');
    expect((await verifyTask(f.workspace, first.trial.id)).verification?.status).toBe("error");
  } finally { await f.cleanup(); }
}, 15_000);
test("Shiori cancellation drains ordinary process and finalizes exactly once", async () => {
  const f = await fixture(), cancel = new AbortController();
  try {
    await writeFile(f.program, 'import time\nfrom pathlib import Path\nPath("ready").touch()\ntime.sleep(60)\n');
    const pending = runTask("local/jump", { ...f.options, signal: cancel.signal });
    const deadline = Date.now() + 4000;
    while (!await Bun.file(join(f.workspace, "ready")).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(join(f.workspace, "ready")).exists()).toBe(true); cancel.abort();
    const result = await pending;
    expect(result.trial.status).toBe("cancelled"); expect(result.verification).toBeNull();
    const events = (await readFile(join(f.workspace, "logs", result.trial.id, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "benchmark_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "benchmark_end")).toHaveLength(1);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  } finally { cancel.abort(); await f.cleanup(); }
}, 10_000);
test("execution errors stay errors; metric receives one reward or null per explicitly selected trial", async () => {
  const f = await fixture();
  try {
    const good = await runTask("local/jump", f.options);
    await writeFile(f.program, "raise ImportError('missing_measurement_dependency')\n");
    const failed = await runTask("local/jump", f.options);
    expect(failed.trial.status).toBe("error"); expect(failed.verification).toBeNull();
    expect(await readFile(join(f.workspace, "logs", failed.trial.id, "stderr.log"), "utf8")).toContain("missing_measurement_dependency");
    const task = await readTask(f.task), dataset = join(f.root, "dataset.toml");
    await writeFile(dataset, `schema_version="1.0"\n[dataset]\nname="local/sample"\n[[tasks]]\nname="local/jump"\ndigest="${task.digest}"\n`);
    const aggregate = await aggregateTasks(f.workspace, dataset, [good.trial.id, failed.trial.id]);
    expect(aggregate.counts).toMatchObject({ trials: 2, valid: 1, executionErrors: 1 });
    expect(Object.values(aggregate.metrics.byTask)[0]).toEqual({ height: 12, landed: 0 });
    const newer = await verifyTask(f.workspace, good.trial.id);
    await expect(aggregateTasks(f.workspace, dataset, [good.trial.id, `${good.trial.id}@${newer.verification!.id}`])).rejects.toThrow("Duplicate trial");
    await writeFile(join(f.root, "metric.py"), 'import argparse,json\nfrom metric_data import SCALE\np=argparse.ArgumentParser();p.add_argument("-i","--input-path");p.add_argument("-o","--output-path");a=p.parse_args();rows=[json.loads(x) for x in open(a.input_path)];json.dump({"samples":len(rows)*SCALE,"missing":sum(x is None for x in rows)},open(a.output_path,"w"))\n');
    await writeFile(join(f.root, "metric_data.py"), "SCALE=1\n");
    await writeFile(dataset, (await readFile(dataset, "utf8")) + '\n[[files]]\npath="metric_data.py"\n');
    expect((await aggregateTasks(f.workspace, dataset, [good.trial.id, failed.trial.id])).metrics).toEqual({ samples: 2, missing: 1 });
  } finally { await f.cleanup(); }
}, 20_000);
