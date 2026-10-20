import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { builtinDefinitions } from "../../rsa/src/benchmark/builtins";
import { validateDefinition, validateResult } from "../../rsa/src/benchmark/contract";
import { artifactRoot, catalog, resolveRun } from "./data";
import { parseEvents } from "./aggregate";
import {
  definitionKey,
  type BenchmarkDefinition,
  type BenchmarkCatalog,
  type BenchmarkEvidence,
  type BenchmarkResult,
} from "./benchmarks";

async function readResult(project: string, run: string, root: string) {
  const directory = await resolveRun(project, run, root);
  const path = join(directory, "benchmark.json");
  if ((await realpath(path)) !== path)
    throw new Error("基准结果必须位于当前运行目录内");
  const result: BenchmarkResult = JSON.parse(await readFile(path, "utf8"));
  validateResult(result);
  if (result.project !== project || result.runId !== run)
    throw new Error("基准结果身份与运行目录不一致");
  return { result, directory };
}
export async function benchmarkCatalog(
  root = artifactRoot,
  definitions: BenchmarkDefinition[] = builtinDefinitions,
): Promise<BenchmarkCatalog> {
  const projects = await catalog(root, true);
  const issues: BenchmarkCatalog["issues"] = [];
  const entries = new Map<string, BenchmarkCatalog["benchmarks"][number]>(
    definitions.map((definition) => {
      const key = definitionKey(definition);
      return [key, { key, definition, available: true }];
    }),
  );
  // Discovery is an explicit CLI/SDK operation. Reading its snapshot never
  // imports workspace code or starts a Python process on a dashboard refresh.
  await Promise.all(
    projects.map(async (project) => {
      if (!project.workspace) return;
      const path = join(project.workspace, "logs", "benchmarks-catalog.json");
      try {
        if ((await realpath(path)) !== path)
          throw new Error("评测目录快照必须位于工作区 logs 内");
        const snapshot = JSON.parse(await readFile(path, "utf8"));
        if (
          !Array.isArray(snapshot.benchmarks) ||
          !Array.isArray(snapshot.diagnostics)
        )
          throw new Error("无效的评测目录快照");
        for (const definition of snapshot.benchmarks as BenchmarkDefinition[]) {
          validateDefinition(definition);
          if (definition.source === "builtin") continue;
          const key = definitionKey(definition, project.id);
          entries.set(key, {
            key,
            definition,
            project: project.id,
            workspace: project.workspace,
            available: true,
          });
        }
        for (const diagnostic of snapshot.diagnostics)
          issues.push({
            project: project.id,
            error:
              typeof diagnostic === "string"
                ? diagnostic
                : JSON.stringify(diagnostic),
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          issues.push({ project: project.id, error: String(error) });
      }
    }),
  );
  const records = await Promise.all(
    projects.flatMap((project) =>
      project.runs
        .filter((run) => run.kind === "benchmark" || run.benchmark)
        .map(async (run) => {
          try {
            const { result } = await readResult(project.id, run.id, root);
            if (
              !run.benchmark ||
              result.definition.id !== run.benchmark.id ||
              result.definition.revision !== run.benchmark.revision ||
              result.definition.mode !== run.benchmark.mode
            )
              throw new Error("基准结果与 manifest 不一致");
            return result;
          } catch (error) {
            issues.push({
              project: project.id,
              runId: run.id,
              error: String(error),
            });
            return null;
          }
        }),
    ),
  );
  const results = records
    .filter((result) => result !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const result of results) {
    const key = definitionKey(result.definition, result.project);
    if (!entries.has(key))
      entries.set(key, {
        key,
        definition: result.definition,
        project: result.project,
        workspace: result.workspace,
        available: false,
      });
  }
  return { benchmarks: [...entries.values()], results, issues };
}
export async function benchmarkEvidence(
  project: string,
  run: string,
  root = artifactRoot,
): Promise<BenchmarkEvidence> {
  const { result, directory } = await readResult(project, run, root);
  const wanted = new Set(result.checks.flatMap((check) => check.evidenceSeq));
  const log = parseEvents(
    await readFile(join(directory, "events.jsonl"), "utf8"),
  );
  const events = log.filter((event) => wanted.has(event.seq));
  const found = new Set(events.map((event) => event.seq));
  const epochs = log
    .filter(
      (event) =>
        event.type === "control" &&
        event.data.mode === "auto" &&
        event.trace.epoch,
    )
    .map((event) => event.trace.epoch);
  return {
    result,
    events,
    missingSeq: [...wanted].filter((seq) => !found.has(seq)),
    epoch: epochs[0] ?? null,
    epochs,
  };
}
