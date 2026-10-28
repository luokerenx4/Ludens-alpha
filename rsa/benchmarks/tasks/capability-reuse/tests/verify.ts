import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateReuse } from "./evaluate.ts";

export function verify(m: any) {
  if (!Array.isArray(m.events) || !m.epoch) throw new Error("Frozen reuse events and epoch are required");
  const metadata: { limitations?: string[] } = {};
  const result = evaluateReuse(m.events, m.epoch, metadata);
  const rewards: Record<string, number> = {};
  const omitted: Record<string, string> = {};
  for (const [key, check] of Object.entries(result.checks)) {
    if (check.passed === null) omitted[key] = check.actual;
    else rewards[key] = Number(check.passed);
  }
  for (const [key, metric] of Object.entries(result.metrics)) {
    if (metric.value === null) omitted[key] = "Insufficient measurements for this dimension";
    else rewards[key] = metric.value;
  }
  return { rewards, details: { ...result, ...metadata, omitted } };
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
