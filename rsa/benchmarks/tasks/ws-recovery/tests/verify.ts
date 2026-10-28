import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  if (!Array.isArray(m.conditions) || m.conditions.length !== 2) throw new Error("Both recovery conditions are required");
  const rewards: Record<string, number> = {}, details: any[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const c of m.conditions) {
    const [, fallback, cooldown, full, delta] = c.steps;
    const checks = {
      "responses-completed": c.steps.length === 5 && c.steps.every((s: any) => s.stopReason === "stop" && s.output === "OK"),
      fallback: fallback.httpRequests === 1 && fallback.frames === 2 && same(fallback.lastHttpInput, [c.initialText, "request-two"]) && fallback.retryWebsocketAt === fallback.virtualNow + 60_000,
      cooldown: cooldown.connections === 1 && cooldown.frames === 2 && cooldown.httpRequests === 2,
      restore: full.connections === 2 && full.httpRequests === 2 && full.previousResponseId === undefined && full.retryWebsocketAt === undefined && same(full.lastFrameInput, [c.initialText, "request-two", "request-three", "request-four"]),
      delta: delta.httpRequests === 2 && delta.previousResponseId === "ws_3" && same(delta.lastFrameInput, ["request-five"]),
      "no-tool-replay": c.delivered === 1 && c.noReplayHttpBefore === c.noReplayHttpAfter && c.partialStopReason === "error",
    };
    for (const [key, value] of Object.entries(checks)) rewards[c.id + "-" + key] = Number(value);
    Object.assign(rewards, Object.fromEntries(Object.entries({ restored: Number(checks.restore && checks.delta), "sse-requests": c.httpRequests,
      connections: c.connections, "full-frame-bytes": c.fullBytes, "delta-frame-bytes": c.deltaBytes,
      ...(c.fullBytes ? { "delta-ratio": c.deltaBytes / c.fullBytes * 100 } : {}),
      "local-request-ms": c.durations.reduce((a: number, b: number) => a + b, 0) / c.durations.length }).map(([key, value]) => [c.id + "-" + key, value])));
    details.push({ id: c.id, checks, evidence: c.evidence, noReplayEvidence: c.noReplayEvidence,
      omitted: c.fullBytes ? [] : ["delta-ratio: no full frame bytes"] });
  }
  return { rewards, details };
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
