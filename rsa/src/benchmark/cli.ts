/** CLI transport only. All program, verifier and metric execution belongs to Shiori. */
import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { discoverTasks, resolveTask } from "./catalog.ts";
import { compareResults, isObject, validateRewards } from "./contract.ts";
import { get, history, verifications, rebuildHistoryIndex } from "./store.ts";
import { readTask, HARBOR_CONTRACT_REVISION } from "./task.ts";
import { readDataset } from "./dataset.ts";
import { readReward } from "./reward.ts";
import { runTask, verifyTask, aggregateTasks } from "../harness/shiori-benchmark.ts";

export const BENCH_HELP = `rsa bench list
rsa bench help <namespace/task> [--digest sha256:...]
rsa bench run <namespace/task> [--config run.json] [--args '<JSON object>'] [--digest sha256:...] [--seconds n] [--repeat n] [--no-verify]
rsa bench verify <run-id> [--task <task-directory>] [--reason text]
rsa bench get <run-id[@verification-id]>
rsa bench history [namespace/task] [--cursor id] [--limit n]
rsa bench verifications <run-id> [--cursor id] [--limit n]
rsa bench compare <run-id[@verification-id]> <run-id[@verification-id]>
rsa bench aggregate <dataset.toml> <run-id[@verification-id]>... [--policy all|graded]
rsa bench import-legacy [run-id]
rsa bench rebuild-index
rsa bench schema [task|reward|dataset]
rsa bench validate task <task-directory>
rsa bench validate reward <reward-json-file|verifier-directory>
rsa bench validate dataset <dataset.toml>
Tasks follow Harbor 1.4; native program bindings are separate JSON argv configurations.
Shiori owns execution, cancellation and cleanup. Programs write artifacts; tests/test.sh writes reward.json.
verify reads sealed evidence and runs only the verifier, never the original program or an agent.
Exit codes: 0 completed with a valid reward (including 0); 1 execution failure; 2 missing/failed verification.
Offline reads never start Shiori or import an evaluator. There is no universal pass/fail verdict.
schema returns a contract guide, not the complete official JSON Schema. validate performs static native-profile checks.
Use --workspace globally to select another workspace. No implicit batch or retry.`;

export async function benchmarkCommand(args: string[], artifactRoot: string, workspacePath: string) {
  if (!args.length || args[0] === "--help") { console.log(BENCH_HELP); return; }
  const command = args[0];
  const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: {
    args: { type: "string" }, config: { type: "string" }, digest: { type: "string" }, seconds: { type: "string" }, repeat: { type: "string" },
    "no-verify": { type: "boolean" }, task: { type: "string" }, reason: { type: "string" }, cursor: { type: "string" },
    limit: { type: "string" }, policy: { type: "string" },
  } });
  const workspace = resolve(workspacePath);
  const requireValue = (index = 0) => { const value = positionals[index]; if (!value) throw new Error(`Missing argument for bench ${command}`); return value; };
  const result = (reference: string) => { const pieces = reference.split("@"); if (pieces.length > 2 || pieces.some(value => !value)) throw new Error("Invalid trial@verification reference"); return get(workspace, pieces[0]!, pieces[1]); };
  const page = { cursor: values.cursor, ...(values.limit ? { limit: Number(values.limit) } : {}) };
  let output: unknown;
  switch (command) {
    case "list": output = await discoverTasks(workspace); break;
    case "schema": {
      const kind = positionals[0];
      if (kind && !Object.hasOwn(CONTRACT_GUIDES, kind)) throw new Error("schema expects task, reward, or dataset");
      output = kind ? CONTRACT_GUIDES[kind as keyof typeof CONTRACT_GUIDES] : CONTRACT_GUIDES;
      break;
    }
    case "validate": {
      const kind = requireValue(), path = resolve(requireValue(1));
      if (kind === "task") {
        const task = await readTask(path);
        output = { valid: true, kind, name: task.name, digest: task.digest, native: { supported: task.unsupportedRequirements.length === 0, unsupportedRequirements: task.unsupportedRequirements } };
        if (task.unsupportedRequirements.length) process.exitCode = 1;
      } else if (kind === "dataset") {
        const dataset = await readDataset(path);
        output = { valid: true, kind, name: dataset.name, digest: dataset.digest, tasks: dataset.tasks, files: dataset.files };
      } else if (kind === "reward") {
        let rewards: unknown;
        if ((await stat(path)).isDirectory()) rewards = await readReward(path);
        else {
          if ((await stat(path)).size > 1024 * 1024) throw new Error("Reward exceeds 1 MiB");
          rewards = JSON.parse(await readFile(path, "utf8")); validateRewards(rewards);
        }
        output = { valid: true, kind, rewards };
      } else throw new Error("validate expects task, reward, or dataset");
      break;
    }
    case "help": output = await resolveTask(workspace, requireValue(), values.digest); break;
    case "run": {
      const parameters = values.args ? JSON.parse(values.args) : {};
      if (!isObject(parameters)) throw new Error("--args requires a JSON object");
      const repeat = Number(values.repeat ?? 1);
      if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
      const results = [];
      for (let index = 0; index < repeat; index++) {
        const value = await runTask(requireValue(), { workspace, artifactRoot, configPath: values.config,
          parameters, digest: values.digest, seconds: values.seconds ? Number(values.seconds) : undefined, verify: !values["no-verify"] });
        results.push(value);
        const code = value.trial.status !== "completed" ? 1 : values["no-verify"] || value.verification?.status === "completed" ? 0 : 2;
        if (code) { process.exitCode = code; break; }
      }
      output = repeat === 1 ? results[0] : results; break;
    }
    case "verify": {
      const value = await verifyTask(workspace, requireValue(), { taskPath: values.task ? resolve(values.task) : undefined, reason: values.reason });
      output = value; if (value.verification?.status !== "completed") process.exitCode = 2; break;
    }
    case "get": output = await result(requireValue()); break;
    case "history": output = await history(workspace, { ...page, taskName: positionals[0] }); break;
    case "verifications": output = await verifications(workspace, requireValue(), page); break;
    case "compare": output = compareResults(await result(requireValue()), await result(requireValue(1))); break;
    case "aggregate": {
      if (positionals.length < 2) throw new Error("aggregate requires explicitly selected trials");
      if (values.policy && values.policy !== "all" && values.policy !== "graded") throw new Error("--policy must be all|graded");
      output = await aggregateTasks(workspace, resolve(requireValue()), positionals.slice(1), { policy: values.policy as "all" | "graded" | undefined }); break;
    }
    case "import-legacy": {
      const { importLegacyTrial, importLegacyHistory } = await import("./legacy-import.ts");
      output = positionals[0] ? await importLegacyTrial(workspace, positionals[0]) : await importLegacyHistory(workspace); break;
    }
    case "rebuild-index": output = await rebuildHistoryIndex(workspace); break;
    default: throw new Error(`Unknown benchmark command: ${command}`);
  }
  console.log(JSON.stringify(output, null, 2));
}


const harbor = `https://github.com/harbor-framework/harbor/blob/${HARBOR_CONTRACT_REVISION}`;
/** Intentionally a concise consumer guide, not a fork of Harbor's Pydantic JSON schema. */
export const CONTRACT_GUIDES = {
  task: {
    guideOnly: true, kind: "task", format: "Harbor Task", schema_version: "1.4", profile: "ludens-native",
    source: `${harbor}/src/harbor/models/task/config.py`, revision: HARBOR_CONTRACT_REVISION,
    requiredFiles: ["task.toml", "instruction.md", "tests/test.sh", "environment/ (or a declared docker_image, which native cannot execute)"],
    requiredFields: { "task.name": "org/name (required by the Ludens profile)" },
    identity: "Harbor publisher sha256 content digest; task.version is optional display metadata",
    behavior: "File-only discovery; no import or execution. Unsupported native requirements are reported explicitly.",
  },
  reward: {
    guideOnly: true, kind: "reward", format: "Harbor verifier reward",
    source: `${harbor}/src/harbor/verifier/verifier.py`, revision: HARBOR_CONTRACT_REVISION,
    files: ["reward.json", "reward.txt"], precedence: "reward.json; invalid JSON never falls back to reward.txt",
    shape: "reward.json is a flat object of named finite numbers; reward.txt is one finite decimal number",
    semantics: "0 is a valid measurement, not an execution exception; empty objects do not establish success. null is represented by unavailable verifier_result.rewards, not a valid reward file.",
  },
  dataset: {
    guideOnly: true, kind: "dataset", format: "Harbor Dataset", schema_version: "1.0",
    source: `${harbor}/src/harbor/models/dataset/manifest.py`, revision: HARBOR_CONTRACT_REVISION,
    requiredFields: { "dataset.name": "org/name" }, tasks: "[[tasks]] entries contain name and exact sha256 digest, never a local path",
    files: "[[files]] entries contain a simple filename and optional digest; local bytes are verified and pinned by their digest",
    metric: "metric.py -i <reward-or-null JSONL> -o <JSON>; Ludens requires finite numeric output fields",
    behavior: "Static validation checks the manifest and declared files; it does not execute a metric, import a task, or resolve remote packages.",
  },
} as const;
