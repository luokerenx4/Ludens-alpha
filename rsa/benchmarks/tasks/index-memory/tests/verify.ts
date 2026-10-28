import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  if (!m.completedAt || !Array.isArray(m.phases) || !m.afterCloseCache) throw new Error("Index execution did not finish its measurements");
  const rewards: Record<string, number> = { "source-samples-verified": Number(m.sourceSamplesVerified === true), "builders-exited": Number(m.buildersExited === true),
    "heap-peak-bytes": m.peakHeapSampled, "rss-peak-bytes": m.peakRssSampled, "combined-rss-peak-bytes": m.peakCombinedRssSampled,
    "heap-after-close-bytes": m.afterClose.heapUsed, "rss-after-close-bytes": m.afterClose.rss, events: m.events, calls: m.calls };
  for (const phase of m.phases) rewards[phase.name + "-ms"] = phase.ms;
  return { rewards, details: { afterCloseCache: m.afterCloseCache, queryMetrics: m.queryMetrics, budget: m.budget, limitations: m.limitations } };
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
