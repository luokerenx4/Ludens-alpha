/** Module-to-program adapter. Shiori owns identity, budgets and terminal records. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventLog } from "./events.ts";
import { atomicJson } from "../benchmark/store.ts";
import type { BenchmarkContext } from "../benchmark/types.ts";
import type { ProgramMessage } from "./program.ts";

const entry = process.argv[2];
if (!entry) throw new Error("A module execution entry is required");
if (!process.send) throw new Error("Fixture program requires Shiori event transport");
const budgetEnd = new AbortController();
const cancellation = new AbortController();
const budgetReady = Promise.withResolvers<number>();
const pending = new Map<string, () => void>();
process.on("message", (message: ProgramMessage) => {
  if (message?.kind === "flushed") { pending.get(message.id)?.(); pending.delete(message.id); }
  if (message?.kind === "budget") budgetReady.resolve(message.deadlineMs);
  if (message?.kind === "stop") budgetEnd.abort(new DOMException(message.reason, "AbortError"));
});
const flush = () => new Promise<void>(resolve => { const id = crypto.randomUUID(); pending.set(id, resolve); process.send!({ kind: "flush", id }); });
const log = new EventLog(process.env.RSA_BENCH_RUN_DIR!, { id: process.env.RSA_BENCH_TRIAL_ID!, now: () => performance.now() },
  process.env.RSA_BENCH_WORKSPACE!, "normal", (type, data, trace, metadata) => process.send!({ kind: "event", type, data, trace, metadata }), flush);
process.send({ kind: "ready" });
const input = JSON.parse(await readFile(process.env.RSA_BENCH_INPUT!, "utf8"));
const cancel = () => cancellation.abort(new Error("Shiori cancelled program"));
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
const metadata: BenchmarkContext["metadata"] = {};
let exitCode = 0;
try {
  const budget = { deadlineMs: await budgetReady.promise, signal: budgetEnd.signal };
  const { run } = await import(pathToFileURL(resolve(entry)).href);
  const measurements = await run({ runDir: log.directory, workspace: process.cwd(), log, metadata,
    model: input.parameters.model ?? "openai-codex/gpt-6.1-sol", seconds: input.budgetSeconds,
    maxRequests: input.parameters.maxRequests ?? 30, seed: input.parameters.seed ?? 7, signal: cancellation.signal, budget });
  cancellation.signal.throwIfAborted();
  await atomicJson(join(process.env.RSA_BENCH_ARTIFACTS!, "measurements.json"), measurements);
} catch (error) { console.error(error); exitCode = 1; }
finally {
  await atomicJson(join(process.env.RSA_BENCH_ARTIFACTS!, "context.json"), { ...metadata, trialId: process.env.RSA_BENCH_TRIAL_ID, workspace: process.cwd() });
  await flush();
  process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
}
// OMP fixture imports may own process-wide background services; Shiori has already drained the work.
process.exit(exitCode);
