import type { RecordEvent, Trace } from "./protocol.ts";

type Counts = { calls: number; errors: number; durationMs: number; minDurationMs: number; maxDurationMs: number };
type Interval = { trace: Trace; startedAt: number; controllers: Map<string, Counts> };
type Fault = { trace: Trace; controllerId: string; category: string; firstAt: number; lastAt: number;
  count: number; firstError: string; lastError: string; lastSuccessAt?: number };

/** Bounded by active controllers/recordings, never by the number of samples. */
export class SamplingStats {
  private intervals = new Map<string, Interval>();
  private faults = new Map<string, Fault>();
  constructor(private record: RecordEvent, private now = Date.now, readonly periodMs = 5000) {}

  observe(controllerId: string, trace: Trace, durationMs: number, error?: unknown) {
    const now = this.now(), key = JSON.stringify([trace.recordingId ?? null, trace.epoch ?? null]);
    const attribution: Trace = { ...(trace.recordingId ? { recordingId: trace.recordingId } : {}),
      ...(trace.epoch ? { epoch: trace.epoch } : {}), ...(trace.recordingPurpose ? { recordingPurpose: trace.recordingPurpose } : {}) };
    let interval = this.intervals.get(key);
    if (!interval) this.intervals.set(key, interval = { trace: attribution, startedAt: now, controllers: new Map() });
    let counts = interval.controllers.get(controllerId);
    if (!counts) interval.controllers.set(controllerId, counts = { calls: 0, errors: 0, durationMs: 0, minDurationMs: Infinity, maxDurationMs: 0 });
    counts.calls++; counts.errors += error === undefined ? 0 : 1; counts.durationMs += durationMs;
    counts.minDurationMs = Math.min(counts.minDurationMs, durationMs); counts.maxDurationMs = Math.max(counts.maxDurationMs, durationMs);
    if (trace.recordingPurpose !== "continuous-perception") return;
    if (error === undefined) {
      for (const [faultKey, fault] of this.faults) if (faultKey.startsWith(key + ":") && fault.controllerId === controllerId) fault.lastSuccessAt = now;
      return;
    }
    // Error text often contains frame IDs or timestamps. It is a sample, never the grouping key.
    const category = error instanceof Error ? error.name : "ExecutionFailure";
    const faultKey = key + ":" + JSON.stringify([controllerId, category]);
    const sample = String(error).slice(0, 2048);
    const fault = this.faults.get(faultKey);
    if (fault) { fault.count++; fault.lastAt = now; fault.lastError = sample; }
    else {
      const opened = { trace: attribution, controllerId, category, firstAt: now, lastAt: now, count: 1, firstError: sample, lastError: sample };
      this.faults.set(faultKey, opened);
      this.record("device_sampling_error", this.describe(opened), attribution);
    }
  }

  private describe(fault: Fault) {
    const { trace: _, ...data } = fault;
    return data;
  }

  flush(stopping = false, recordingId?: string) {
    const now = this.now();
    for (const [key, interval] of this.intervals) {
      if (recordingId !== undefined && interval.trace.recordingId !== recordingId) continue;
      this.record("device_sampling_stats", {
        startedAt: interval.startedAt, endedAt: now,
        controllers: [...interval.controllers].map(([controllerId, counts]) => ({ controllerId, ...counts })),
        faults: [...this.faults.values()].filter(f => f.trace.recordingId === interval.trace.recordingId && f.trace.epoch === interval.trace.epoch).map(f => this.describe(f)),
      }, interval.trace);
      this.intervals.delete(key);
    }
    for (const [key, fault] of this.faults) {
      if (recordingId !== undefined && fault.trace.recordingId !== recordingId) continue;
      if (stopping || (now - fault.lastAt >= this.periodMs && fault.lastSuccessAt !== undefined && fault.lastSuccessAt > fault.lastAt)) {
        this.record("device_sampling_recovered", { ...this.describe(fault), endedAt: now, reason: stopping ? "stopped" : "recovered" }, fault.trace);
        this.faults.delete(key);
      }
    }
  }
}
