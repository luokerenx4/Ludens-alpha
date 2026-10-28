import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  if (!Array.isArray(m.measurements) || m.measurements.length !== 2) throw new Error("Both handoff scenarios are required");
  const checks = { ...Object.fromEntries(m.measurements.map((v: any) => [v.scenario + "-interrupted", v.manual && v.neutral && v.cancelled && v.pythonGone])),
    "release-latency": m.measurements.every((v: any) => v.neutralMs <= 500), "stale-epoch": m.staleRejected && !m.staleExecuted };
  return { rewards: { ...Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, Number(value)])),
    "handback-ms": Math.max(...m.measurements.map((v: any) => v.handbackMs)), "neutral-ms": Math.max(...m.measurements.map((v: any) => v.neutralMs)),
    "caller-settle-ms": Math.max(...m.measurements.map((v: any) => v.settleMs)), scenarios: m.measurements.length },
    details: { checks, evidence: m.evidence, staleEpochEvidence: m.staleEpochEvidence } };
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
