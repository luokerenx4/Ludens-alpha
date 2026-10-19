import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactRoot, catalog, resolveRun } from "./data";
import { parseEvents } from "./aggregate";
import type {
  BenchmarkCase,
  BenchmarkCatalog,
  BenchmarkEvidence,
  BenchmarkResult,
} from "./benchmarks";

const casesPath = resolve(process.cwd(), "../rsa/benchmarks/cases.json");
async function readResult(project: string, run: string, root: string) {
  const directory = await resolveRun(project, run, root);
  const path = join(directory, "benchmark.json");
  if ((await realpath(path)) !== path)
    throw new Error("基准结果必须位于当前运行目录内");
  const result: BenchmarkResult = JSON.parse(await readFile(path, "utf8"));
  if (
    result.schemaVersion !== 1 ||
    result.project !== project ||
    result.runId !== run
  )
    throw new Error("基准结果身份与运行目录不一致");
  return { result, directory };
}
export async function benchmarkCatalog(
  root = artifactRoot,
  definitions = casesPath,
): Promise<BenchmarkCatalog> {
  const [cases, projects] = await Promise.all([
    readFile(/* turbopackIgnore: true */ definitions, "utf8").then(
      (text) => JSON.parse(text) as BenchmarkCase[],
    ),
    catalog(root),
  ]);
  const issues: BenchmarkCatalog["issues"] = [];
  const results = await Promise.all(
    projects.flatMap((project) =>
      project.runs
        .filter((run) => run.benchmark)
        .map(async (run) => {
          try {
            const { result } = await readResult(project.id, run.id, root);
            if (
              result.caseId !== run.benchmark!.caseId ||
              result.caseVersion !== run.benchmark!.caseVersion ||
              result.mode !== run.benchmark!.mode
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
  return {
    cases,
    results: results
      .filter((result) => result !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    issues,
  };
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
