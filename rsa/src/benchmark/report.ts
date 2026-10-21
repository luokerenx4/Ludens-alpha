import Ajv from "ajv";
import schema from "../../benchmarks/report.schema.json";
import type { AuthorReport, CaseOutcome, ReportIssue } from "./contract.ts";
export { schema as reportSchema };
const validate = new Ajv({ allErrors: true, strictNumbers: true, allowUnionTypes: true }).compile(schema);

/** JSON serialization must never turn a failed measurement (NaN) into a missing one. */
export function jsonIssues(value: unknown, path = "", seen = new Set<object>()): ReportIssue[] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [{ path, message: "must be a finite JSON number; use null for an explicitly missing measurement" }];
  if (typeof value !== "object") return [{ path, message: `not a JSON value (${typeof value})` }];
  if (seen.has(value)) return [{ path, message: "circular value is not JSON" }];
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return [{ path, message: "must be an ordinary JSON object" }];
  seen.add(value);
  const issues = Object.entries(value).flatMap(([key, item]) => jsonIssues(item, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, seen));
  seen.delete(value);
  return issues;
}
export function validateAuthorReport(raw: unknown): { errors: ReportIssue[]; outcome: CaseOutcome | null } {
  const errors = jsonIssues(raw);
  if (errors.length) return { errors, outcome: null };
  if (!validate(raw)) for (const issue of validate.errors ?? []) {
    errors.push({ path: issue.instancePath, message: issue.message ?? "invalid value" });
  }
  if (errors.length) return { errors, outcome: null };
  const report = raw as AuthorReport;
  return { errors, outcome: {
    metrics: Object.entries(report.metrics ?? {}).map(([id, metric]) => ({ id, direction: "none", ...metric })),
    checks: Object.entries(report.checks ?? {}).map(([id, check]) => ({ id, label: id, evidenceSeq: [], ...check })),
  } };
}
