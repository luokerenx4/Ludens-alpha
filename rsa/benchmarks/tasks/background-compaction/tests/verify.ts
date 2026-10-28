import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  const linked = !!m.started?.trace.traceId && !!m.started.trace.spanId && !!m.armed && !!m.applied &&
    m.lifecycle.every((e: any) => e.trace.epoch === m.originEpoch && e.trace.spanId === m.started.trace.spanId) &&
    m.http.length === 1 && m.http.every((e: any) => e.trace.epoch === m.originEpoch && e.trace.parentSpanId === m.started.trace.spanId && e.trace.traceId === m.started.trace.traceId);
  const checks = { "reuse-candidate": m.requests === 1 && m.commits === 1 && m.originalLeaf,
    "tail-preserved": m.tailPreserved, "late-identity": linked && m.orphanParents.length === 0,
    "headers-not-ready": !!m.headers && !!m.armed && m.headers.atMs < m.armed.atMs,
    "cancel-no-commit": m.cancellationSettled && !m.cancelCommitted };
  const optional = { "prepare-ms": m.armed?.data.durationMs, "foreground-wait-ms": m.maintenance?.data.durationMs };
  return { rewards: { ...Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, Number(value)])),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => typeof value === "number")),
    "summary-requests": m.requests, "duplicate-summary": Math.max(0, m.requests - 1), "orphan-parents": m.orphanParents.length, "cancel-ms": m.cancellationMs },
    details: { checks, evidence: m.evidence, omitted: Object.keys(optional).filter(key => typeof optional[key as keyof typeof optional] !== "number") } };
}

if (import.meta.main) {
  if (!process.env.RSA_BENCH_INPUT || !process.env.RSA_BENCH_ARTIFACTS || !process.env.RSA_BENCH_VERIFIER_DIR)
    throw new Error("Shiori verification paths are required");
  JSON.parse(readFileSync(process.env.RSA_BENCH_INPUT, "utf8"));
  const result = verify(JSON.parse(readFileSync(join(process.env.RSA_BENCH_ARTIFACTS, "measurements.json"), "utf8")));
  const rewards = result.rewards;
  if (!Object.values(rewards).every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("Invalid task reward");
  writeFileSync(join(process.env.RSA_BENCH_VERIFIER_DIR, "reward.json"), JSON.stringify(rewards) + "\n");
  writeFileSync(join(process.env.RSA_BENCH_VERIFIER_DIR, "details.json"), JSON.stringify(result.details) + "\n");
}
