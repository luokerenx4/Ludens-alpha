import cases from "../../benchmarks/cases.json";
import type { BenchmarkDefinition } from "./contract.ts";

/** Metadata only: safe for the CLI and Dashboard to share. */
export const builtinDefinitions: BenchmarkDefinition[] = cases.map(item => ({
  id: item.id, title: item.title, description: item.description, scope: item.scope,
  revision: String(item.version), source: "builtin", mode: item.mode as "offline" | "live",
  targets: [item.id === "control-handoff" ? "baseware/control" : item.id === "perception-lifecycle" ? "rsa/perception" : "shiori/omp"],
  parameters: { type: "object", additionalProperties: false, properties: {
    model: { type: "string", default: "openai-codex/gpt-6.1-sol" },
    seconds: { type: "integer", minimum: 1, default: 180 },
    maxRequests: { type: "integer", minimum: 1, default: 30 },
    seed: { type: "integer", default: 7 },
  } }, entry: { kind: "builtin", caseId: item.id },
}));
