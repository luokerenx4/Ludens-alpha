import type { EventLog } from "../harness/events.ts";

export interface BenchmarkContext {
  runDir: string;
  workspace: string;
  log: EventLog;
  model: string;
  seconds: number;
  maxRequests: number;
  seed: number;
  signal?: AbortSignal;
}
export interface BenchmarkCheck {
  id: string;
  label: string;
  passed: boolean | null;
  expected: string;
  actual: string;
  evidenceSeq: number[];
}
export interface BenchmarkMetric {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  direction?: "lower" | "higher" | "none";
}
export interface CaseOutcome {
  checks: BenchmarkCheck[];
  metrics: BenchmarkMetric[];
  limitations?: string[];
}
export type BenchmarkStatus = "running" | "passed" | "failed" | "inconclusive" | "error" | "skipped";
export interface BenchmarkResult extends CaseOutcome {
  schemaVersion: 1;
  caseId: string;
  caseVersion: number;
  title: string;
  mode: "offline" | "live";
  status: BenchmarkStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  runId: string;
  project: string;
  parameters: { model: string | null; seconds: number; maxRequests: number; seed: number };
  provenance: { code: { commit: string; dirty: boolean } | null; prompts: Record<string, string>; workspaceInstructionsSHA256: string };
  error?: string;
}
