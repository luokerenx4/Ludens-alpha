import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkCommand } from "../src/benchmark/cli.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-bench-static-"))); roots.push(root); return root; }
async function invoke(args: string[], workspace: string) {
  const output: string[] = [], previous = process.exitCode;
  const log = spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  try { process.exitCode = 0; await benchmarkCommand(args, join(workspace, "state"), workspace); return { value: JSON.parse(output.at(-1)!), code: process.exitCode ?? 0 }; }
  finally { log.mockRestore(); process.exitCode = previous ?? 0; }
}
async function packageAt(root: string) {
  const task = join(root, "task"); await mkdir(join(task, "environment"), { recursive: true }); await mkdir(join(task, "tests"));
  await writeFile(join(task, "task.toml"), 'schema_version="1.4"\n[task]\nname="local/static"\n');
  await writeFile(join(task, "instruction.md"), "Static test");
  await writeFile(join(task, "tests/test.sh"), `#!/bin/sh\ntouch '${join(root, "must-not-execute")}'\n`);
  await writeFile(join(task, "environment/module.py"), `from pathlib import Path\nPath(${JSON.stringify(join(root, "must-not-import"))}).touch()\n`);
  return task;
}

test("schema selects contract guides and rejects unknown kinds", async () => {
  const root = await temporary();
  const all = await invoke(["schema"], root);
  expect(Object.keys(all.value)).toEqual(["task", "reward", "dataset"]);
  expect(all.value.task).toMatchObject({ guideOnly: true, schema_version: "1.4", profile: "ludens-native" });
  expect(all.value.dataset.schema_version).toBe("1.0");
  expect((await invoke(["schema", "reward"], root)).value).toEqual(all.value.reward);
  await expect(invoke(["schema", "report"], root)).rejects.toThrow("expects");
});

test("Task validation is static and reports native incompatibility separately from valid format", async () => {
  const root = await temporary(), task = await packageAt(root);
  const valid = await invoke(["validate", "task", task], root);
  expect(valid).toMatchObject({ code: 0, value: { valid: true, native: { supported: true } } });
  await writeFile(join(task, "task.toml"), (await readFile(join(task, "task.toml"), "utf8")) + '\n[environment]\ncpus=2\n');
  expect(await invoke(["validate", "task", task], root)).toMatchObject({ code: 1, value: { valid: true, native: { supported: false, unsupportedRequirements: ["environment.cpus"] } } });
  expect(await stat(join(root, "must-not-execute")).catch(() => null)).toBeNull();
  expect(await stat(join(root, "must-not-import")).catch(() => null)).toBeNull();
  expect(await stat(join(root, "logs")).catch(() => null)).toBeNull();
});

test("Reward validation rejects boolean/nested/null and retains JSON precedence", async () => {
  const root = await temporary(), path = join(root, "reward.json");
  await writeFile(path, '{"score":0}');
  expect((await invoke(["validate", "reward", path], root)).value.rewards).toEqual({ score: 0 });
  await writeFile(join(root, "reward.txt"), "1");
  for (const value of ["null", '{"score":true}', '{"score":{"nested":1}}']) {
    await writeFile(path, value);
    await expect(invoke(["validate", "reward", root], root)).rejects.toThrow("finite numbers");
  }
});

test("Dataset validation hashes declared files without invoking the metric", async () => {
  const root = await temporary();
  await writeFile(join(root, "metric.py"), `raise RuntimeError('must not execute')\n`);
  const path = join(root, "dataset.toml");
  await writeFile(path, '[dataset]\nname="local/static"\n[[files]]\npath="metric.py"\n');
  expect((await invoke(["validate", "dataset", path], root)).value).toMatchObject({ valid: true, kind: "dataset", name: "local/static", tasks: [] });
  await writeFile(path, '[dataset]\nname="local/static"\n[[tasks]]\nname="local/task"\ndigest="bad"\n');
  await expect(invoke(["validate", "dataset", path], root)).rejects.toThrow("digest");
});
