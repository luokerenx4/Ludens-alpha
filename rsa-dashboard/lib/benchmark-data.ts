import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { builtinDefinitions } from "../../rsa/src/benchmark/builtins";
import { validateDefinition } from "../../rsa/src/benchmark/contract";
import { readResult as readStoredResult } from "../../rsa/src/benchmark/store";
import { artifactRoot, catalog, resolveRun } from "./data";
import { createReadStream } from "node:fs";
import { readRunEvents } from "../../shared/event-sources";
import type { Event } from "./types";
import {
  definitionKey,
  type BenchmarkDefinition,
  type BenchmarkCatalog,
  type BenchmarkEvidence,
  type BenchmarkResult,
} from "./benchmarks";

async function readResult(
  project: string,
  run: string,
  root: string,
  reportId?: string,
) {
  const directory = await resolveRun(project, run, root);
  // Resolve through the trusted workspace index, never a path from report data.
  const workspace = dirname(dirname(directory));
  const result = await readStoredResult(workspace, run, reportId);
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
              result.definition.protocolVersion !==
                run.benchmark.protocolVersion
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
  reportId?: string,
  signal?: AbortSignal,
): Promise<BenchmarkEvidence> {
  const { result, directory } = await readResult(project, run, root, reportId);
  const wanted = new Set(result.checks.flatMap((check) => check.evidenceSeq));
  const wantedEvents = new Set(result.checks.flatMap(check => check.evidenceEvents ?? []));
  let logAvailable = true;
  const events: Event[] = [], epochs: string[] = [];
  const stream = createReadStream(join(directory, "events.jsonl"), { encoding: "utf8", signal });
  let pending = "";
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      pending += chunk;
      let start = 0, newline: number;
      while ((newline = pending.indexOf("\n", start)) !== -1) {
        const line = pending.slice(start, newline); start = newline + 1;
        if (!line.trim()) continue;
        const event = JSON.parse(line) as Event;
        if (wanted.has(event.seq)) events.push(event);
        if (event.type === "control" && event.data.mode === "auto" && event.trace.epoch) epochs.push(event.trace.epoch);
      }
      // A writer's unterminated final line is not committed yet.
      pending = pending.slice(start);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    logAvailable = false;
  } finally { stream.destroy(); }
  // Numeric references are deliberately local: service sequence numbers are not globally unique.
  const found = new Set(events.map(event => event.seq)), foundEvents = new Set(events.flatMap(event => event.origin?.eventId ? [event.origin.eventId] : []));
  if (wantedEvents.size) for await (const raw of readRunEvents(directory, { signal })) {
    signal?.throwIfAborted();
    const event = raw as Event, id = event.origin?.eventId;
    if (id && wantedEvents.has(id) && !foundEvents.has(id)) { events.push(event); foundEvents.add(id); }
  }
  return {
    result,
    events,
    missingSeq: [...wanted].filter((seq) => !found.has(seq)),
    missingEvents: [...wantedEvents].filter(id => !foundEvents.has(id)),
    epoch: epochs[0] ?? null,
    epochs,
    logAvailable,
  };
}
