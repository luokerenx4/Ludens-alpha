import type { LoopParams } from "./loop-lab";

export type LoopParamKey = keyof LoopParams;
export type LoopDraft = Record<LoopParamKey, string>;
export interface LoopParamDefinition {
  min: number;
  max: number;
  /** Suggested input increment; precise values need not be a multiple of it. */
  step: number;
  integer: boolean;
}

/** The simulator and editor share a bounded, finite domain. Token/count fields are integers. */
export const LOOP_PARAM_DEFS: Record<LoopParamKey, LoopParamDefinition> = {
  batches: { min: 0, max: 30, step: 1, integer: true },
  batchSec: { min: 0.01, max: 30, step: 0.5, integer: false },
  finalSec: { min: 0.01, max: 30, step: 1, integer: false },
  budget: { min: 0.01, max: 3600, step: 30, integer: false },
  maxReq: { min: 1, max: 200, step: 1, integer: true },
  hz: { min: 0.01, max: 60, step: 1, integer: false },
  changeRate: { min: 0.01, max: 5, step: 0.01, integer: false },
  fText: { min: 0, max: 2000, step: 50, integer: true },
  fImg: { min: 0, max: 4, step: 1, integer: true },
  iTok: { min: 0, max: 4000, step: 50, integer: true },
  obs: { min: 0, max: 10, step: 1, integer: true },
  imgCap: { min: 1, max: 200, step: 1, integer: true },
  sysTpl: { min: 0, max: 30000, step: 500, integer: true },
  agents: { min: 0, max: 20000, step: 500, integer: true },
  schema: { min: 0, max: 2000, step: 20, integer: true },
  remind: { min: 0, max: 500, step: 10, integer: true },
  tool: { min: 0, max: 4000, step: 100, integer: true },
  asst: { min: 0, max: 2000, step: 50, integer: true },
  thresh: { min: 1, max: 10_000_000, step: 5000, integer: true },
  keep: { min: 0, max: 100000, step: 1000, integer: true },
  seed: { min: 0, max: 0xffffffff, step: 1, integer: true },
};

export const LOOP_PARAM_KEYS = Object.keys(LOOP_PARAM_DEFS) as LoopParamKey[];

const group = (title: "loop" | "env" | "baseline", keys: LoopParamKey[]) => ({
  title,
  items: keys.map(key => ({ key, ...LOOP_PARAM_DEFS[key] })),
});

export const PARAM_GROUPS = [
  group("loop", ["batches", "batchSec", "finalSec", "budget", "maxReq"]),
  group("env", ["hz", "changeRate", "fText", "fImg", "iTok", "obs", "imgCap"]),
  group("baseline", ["sysTpl", "agents", "schema", "remind", "tool", "asst", "thresh", "keep", "seed"]),
];

export interface LoopParamError {
  code: "required" | "number" | "integer" | "range";
  min?: number;
  max?: number;
}

export type LoopParamErrors = Partial<Record<LoopParamKey, LoopParamError>>;
export type LoopValidation = { params: LoopParams; errors: LoopParamErrors } | { params: null; errors: LoopParamErrors };

export function createLoopDraft(params: LoopParams): LoopDraft {
  return Object.fromEntries(LOOP_PARAM_KEYS.map(key => [key, String(params[key])])) as LoopDraft;
}

function numberError(key: LoopParamKey, value: number): LoopParamError | undefined {
  const { integer, min, max } = LOOP_PARAM_DEFS[key];
  if (!Number.isFinite(value)) return { code: "number" };
  if (integer && !Number.isSafeInteger(value)) return { code: "integer" };
  if (value < min || value > max) return { code: "range", min, max };
}

export function validateLoopParams(params: LoopParams): LoopValidation {
  const errors: LoopParamErrors = {};
  for (const key of LOOP_PARAM_KEYS) {
    const error = numberError(key, params?.[key]);
    if (error) errors[key] = error;
  }
  return { params: Object.keys(errors).length ? null : { ...params }, errors };
}

/** Preserve drafts verbatim, including incomplete decimals, until the user applies them. */
export function validateLoopDraft(draft: LoopDraft): LoopValidation {
  const params = {} as LoopParams;
  const errors: LoopParamErrors = {};
  for (const key of LOOP_PARAM_KEYS) {
    const raw = draft[key]?.trim() ?? "";
    if (!raw) errors[key] = { code: "required" };
    else if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) errors[key] = { code: "number" };
    else {
      params[key] = Number(raw);
      const error = numberError(key, params[key]);
      if (error) errors[key] = error;
    }
  }
  return { params: Object.keys(errors).length ? null : params, errors };
}

export function assertLoopParams(params: LoopParams): void {
  const validation = validateLoopParams(params);
  if (validation.params) return;
  const fields = Object.entries(validation.errors).map(([key, error]) => `${key}: ${error.code}`).join(", ");
  throw new RangeError(`Invalid loop parameters (${fields})`);
}
