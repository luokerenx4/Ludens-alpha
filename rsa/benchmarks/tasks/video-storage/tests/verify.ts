import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verify(m: any) {
  if (!m.samples?.length || !m.coldDecodedFrames || !(m.elapsedSeconds > 0)) throw new Error("Recording and cold decode evidence required");
  const mid = m.samples.slice(Math.floor(m.samples.length / 3), Math.floor(2 * m.samples.length / 3));
  const tail = m.samples.slice(Math.floor(2 * m.samples.length / 3));
  const mean = (items: any[]) => items.reduce((sum, point) => sum + point.rssBytes, 0) / items.length;
  return { rewards: { "cold-decoded-frames": m.coldDecodedFrames, "mean-pixel-error-max": m.maximumMeanPixelError,
    "effective-records-hz": m.records / m.elapsedSeconds, "video-bytes": m.videoBytes,
    "compression-ratio": m.pngBytesIfArchived / m.videoBytes, "rss-peak-bytes": Math.max(...m.samples.map((p: any) => p.rssBytes)),
    ...(mid.length ? { "rss-tail-minus-middle-bytes": mean(tail) - mean(mid) } : {}),
    "hot-peak-bytes": Math.max(...m.samples.map((p: any) => p.hotBytes)), "original-image-files": m.imageFiles },
    details: { requestedRate: m.rate, records: m.records, metrics: m.metrics, limitations: ["Throughput uses actual elapsed time, not nominal sample_hz; RSS is sampled and excludes unsampled peaks."] } };
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
