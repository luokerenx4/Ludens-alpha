import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventTrace } from "../../harness/events.ts";

export interface EvidenceEvent {
  seq: number; type: string; atMs: number; trace: EventTrace; data: Record<string, any>;
}
export const readEvents = async (directory: string): Promise<EvidenceEvent[]> =>
  (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, signal?: AbortSignal) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    if (await check()) return;
    if (performance.now() >= deadline) throw new Error(`Benchmark condition timed out after ${timeoutMs} ms`);
    await Bun.sleep(5);
  }
}

export const seqs = (events: EvidenceEvent[], predicate: (event: EvidenceEvent) => boolean) =>
  events.filter(predicate).map(event => event.seq);

export const syntheticKey = `aaa.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "playness-offline-benchmark" },
})).toString("base64url")}.bbb`;
