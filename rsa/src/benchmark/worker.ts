import { readFile } from "node:fs/promises";
import { EventLog } from "../harness/events.ts";
import type { WorkerInput } from "./runner.ts";
import { benchmarkEventSummary, type CaseMetadata } from "./contract.ts";
import { saveReport, writeResult } from "./store.ts";

const input: WorkerInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const { runDir, result } = input;
const started = performance.now();
const log = new EventLog(runDir, { id: result.runId, now: () => performance.now() }, result.workspace);
const record = log.recorder({ component: "benchmark", implementation: input.caseId, implementationVersion: result.definition.revision });
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("Benchmark worker interrupted"));
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
record("benchmark_start", { benchmarkId: result.definition.id, parameters: result.parameters }, result.trace);
const metadata: CaseMetadata = { conditions: {}, subjects: [], artifacts: [], limitations: [] };
let raw: unknown, phase: "load" | "execute" = "load";
try {
  const { run } = await import(`./cases/${input.caseId}.ts`);
  phase = "execute";
  raw = await run({ ...input, log, metadata, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  result.status = "completed";
} catch (error) {
  result.status = cancellation.signal.aborted ? "cancelled" : "error";
  result.errorPhase = phase;
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  record("benchmark_error", { error: result.error, phase }, result.trace);
} finally {
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  Object.assign(result, metadata, { limitations: [...(result.limitations ?? []), ...(metadata.limitations ?? [])] });
  result.endedAt = new Date().toISOString(); result.durationMs = performance.now() - started;
  record("benchmark_end", { ...benchmarkEventSummary(result), status: result.status }, result.trace);
  await writeResult(runDir, result);
}
if (result.status === "completed") {
  const report = await saveReport(runDir, result, raw ?? {});
  record("benchmark_report", { ...benchmarkEventSummary(result, report), protocolVersion: report.protocolVersion,
    reason: report.reason, valid: !report.errors.length, errors: report.errors }, result.trace);
}
process.exit(result.status === "completed" ? 0 : 1);
