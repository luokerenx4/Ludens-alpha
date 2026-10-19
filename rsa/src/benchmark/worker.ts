import { readFile } from "node:fs/promises";
import { EventLog } from "../harness/events.ts";
import { outcomeStatus, writeResult, type WorkerInput } from "./runner.ts";

const input: WorkerInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const { runDir, workspace, result } = input;
const started = performance.now();
const log = new EventLog(runDir, { id: result.runId, now: () => performance.now() });
const record = log.recorder({ component: "benchmark", implementation: input.caseId, implementationVersion: String(result.caseVersion) });
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("Benchmark worker interrupted"));
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
record("benchmark_start", { caseId: input.caseId, parameters: result.parameters });
try {
  const { run } = await import(`./cases/${input.caseId}.ts`);
  const outcome = await run({ ...input, log, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  Object.assign(result, outcome, { status: outcomeStatus(outcome), limitations: [...(result.limitations ?? []), ...(outcome.limitations ?? [])] });
} catch (error) {
  result.status = "error";
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  record("benchmark_error", { error: result.error });
} finally {
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  result.endedAt = new Date().toISOString();
  result.durationMs = performance.now() - started;
  record("benchmark_end", { caseId: input.caseId, status: result.status, checks: result.checks.map(({ id, passed }) => ({ id, passed })) });
  await writeResult(runDir, result);
}
// OMP may own process-wide services; every case has finished its own cleanup.
process.exit(result.status === "passed" ? 0 : 1);
