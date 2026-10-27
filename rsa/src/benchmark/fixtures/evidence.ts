import { readRunEvents } from "../../../../shared/event-sources.ts";
import type { EventTrace } from "../../harness/events.ts";

export interface EvidenceEvent {
  origin?: {eventId: string}; source?: {component: string};
  seq: number; type: string; atMs: number; trace: EventTrace; data: Record<string, any>;
}
export async function readEvents(directory: string): Promise<EvidenceEvent[]> {
  const events: EvidenceEvent[] = [];
  for await (const event of readRunEvents(directory)) events.push(event as unknown as EvidenceEvent);
  return events;
}

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
  events.filter(event => event.source?.component !== "baseware" && predicate(event)).map(event => event.seq);
export const eventIds = (events: EvidenceEvent[], predicate: (event: EvidenceEvent) => boolean) =>
  events.filter(predicate).flatMap(event => event.origin ? [event.origin.eventId] : []);

export const syntheticKey = `aaa.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "playness-offline-benchmark" },
})).toString("base64url")}.bbb`;
