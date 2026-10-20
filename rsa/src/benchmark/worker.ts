import { readFile } from "node:fs/promises";
import { EventLog } from "../harness/events.ts";
import type { WorkerInput } from "./runner.ts";
import { outcomeVerdict, validateOutcome } from "./contract.ts";
import { writeResult } from "./store.ts";

const input: WorkerInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const { runDir, result } = input;
const started = performance.now();
const log = new EventLog(runDir, { id: result.runId, now: () => performance.now() });
const record = log.recorder({ component: "benchmark", implementation: input.caseId, implementationVersion: result.definition.revision });
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("Benchmark worker interrupted"));
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
record("benchmark_start", { benchmarkId: result.definition.id, parameters: result.parameters }, result.trace);
try {
  const { run } = await import(`./cases/${input.caseId}.ts`);
  const outcome = await run({ ...input, log, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  validateOutcome(outcome);
  Object.assign(result, outcome, { status: "completed", verdict: outcomeVerdict(outcome),
    limitations: [...(result.limitations ?? []), ...(outcome.limitations ?? [])] });
} catch (error) {
  result.status = cancellation.signal.aborted ? "cancelled" : "error"; result.verdict = null;
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  record("benchmark_error", { error: result.error }, result.trace);
} finally {
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  result.endedAt = new Date().toISOString(); result.durationMs = performance.now() - started;
  record("benchmark_end", { benchmarkId: result.definition.id, status: result.status, verdict: result.verdict,
    checks: result.checks.map(({ id, passed }) => ({ id, passed })) }, result.trace);
  await writeResult(runDir, result);
}
process.exit(result.status === "completed" ? 0 : 1);
