import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  if (!Array.isArray(m.inputs) || !m.inputs.length || m.inputs.length !== m.outputs?.length) throw new Error("Matching nonempty inputs and outputs required");
  const correct = m.outputs.filter((v: number, i: number) => v === Math.min(1, Math.max(0, m.inputs[i]))).length;
  return { rewards: { correctness: correct / m.inputs.length, all_in_range: Number(correct === m.inputs.length), call_time_ms: m.elapsedMs / m.inputs.length },
    details: { correct, samples: m.inputs.length, omitted: { peak_memory: "Memory was not sampled" } } };
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
