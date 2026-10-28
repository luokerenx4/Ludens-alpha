import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  const r = m.readings, s = m.statuses;
  const value = (name: string) => JSON.parse(r[name].records[0].text);
  const v1 = value("first"), v2 = value("second"), held = value("beforeReload"), fresh = value("reloaded"), fixed = value("repaired");
  const checks = {
    "empty-bootstrap": s.unimplemented.state === "unimplemented" && !r.missing.ok && !!r.missing.error?.message && !r.missing.records.length,
    "persistent-model": m.startsBeforeReload === 1 && v1.pid === v2.pid && v1.version === 11 && v2.version === 11 && v2.sequence > v1.sequence,
    "explicit-reload": held.version === 11 && fresh.version === 25 && r.beforeReload.records[0].generation !== r.reloaded.records[0].generation && m.closed.includes(held.pid),
    "repair": s.failed.state === "error" && !r.failed.ok && !!r.failed.error && s.repaired.state === "ready" && r.repaired.ok && fixed.version === 25 && s.failed.generation !== s.repaired.generation,
    "temporal-history": r.historical.records[0]?.id === r.first.records[0]?.id && r.historical.records[0]?.text === r.first.records[0]?.text && r.historical.records[0]?.generation !== r.reloaded.records[0]?.generation,
    "immutable-evidence": m.archiveUnchanged && r.first.records[0]?.id !== r.second.records[0]?.id && r.first.records[0]?.media[0]?.id !== r.second.records[0]?.media[0]?.id,
  };
  return { rewards: { ...Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, Number(value)])),
    "initializations-before-reload": m.startsBeforeReload, "cold-read-ms": m.coldMs, "warm-read-ms": m.warmMs }, details: { checks, evidence: m.evidence } };
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
