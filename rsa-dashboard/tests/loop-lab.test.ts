import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, defaultParams, simulate, type LoopParams } from "../lib/loop-lab";
import {
  createLoopDraft, LOOP_PARAM_DEFS, LOOP_PARAM_KEYS, PARAM_GROUPS,
  validateLoopDraft, validateLoopParams,
} from "../lib/loop-params";

const preset = (id: string) => {
  const found = PRESETS.find(p => p.id === id);
  assert.ok(found, `preset ${id}`);
  return found!.cfg;
};

test("presets distinguish the deleted batch channel from the current prompt-start-only delivery", () => {
  const legacy = PRESETS.find(p => p.legacy);
  assert.equal(legacy?.id, "legacy");
  assert.equal(preset("now").rsa.ch2, false);
  assert.equal(preset("legacy").rsa.ch2, true);
  // 每个预设都是完整的层配置,手动开关可回到任一预设。
  for (const p of PRESETS) assert.deepEqual(Object.keys(p.cfg.rsa).sort(), ["ch1", "ch2", "cont", "gate", "state"]);
});

test("current behavior injects at most one frame per round; legacy injected per tool batch", () => {
  const params = defaultParams();
  const now = simulate(params, preset("now"));
  const legacy = simulate(params, preset("legacy"));
  assert.equal(now.rounds, legacy.rounds);
  assert.ok(now.frames <= now.rounds, `现状每轮至多一帧, got ${now.frames} in ${now.rounds} rounds`);
  assert.ok(legacy.frames > legacy.rounds, `旧批次末通道应远超轮数, got ${legacy.frames}`);
  assert.ok(legacy.frameTok > now.frameTok * 3, "旧通道应贡献数倍帧 token");
  assert.equal(now.log.filter(e => e.ch === "tool_batch").length, 0);
  assert.ok(legacy.log.filter(e => e.ch === "tool_batch").length > 0);
});

test("pure pull delivers nothing automatically and bare OMP stops after one round", () => {
  const params = defaultParams();
  const pull = simulate(params, preset("pull"));
  assert.equal(pull.log.filter(e => e.ch === "prompt_start" || e.ch === "tool_batch").length, 0);
  assert.equal(pull.frames, params.obs * pull.rounds);

  const bare = simulate(params, preset("bare"));
  assert.equal(bare.rounds, 1);
  assert.equal(bare.frames, 0);
  assert.equal(bare.log.filter(e => e.ch === "state").length, 0);
});

test("native image cap shrinks the wire while delivery history keeps accumulating", () => {
  const params = { ...defaultParams(), thresh: 10_000_000 };
  const capped = simulate(params, { ...preset("legacy"), omp: { ...preset("legacy").omp, imgInf: false } });
  const infinite = simulate(params, preset("legacy"));
  const lastCapped = capped.series.at(-1);
  const lastInfinite = infinite.series.at(-1);
  assert.ok(lastCapped && lastInfinite);
  assert.equal(lastCapped.imgTotal, lastInfinite!.imgTotal, "历史累计帧数不受 wire 裁剪影响");
  assert.ok(lastCapped!.imgShown <= params.imgCap);
  assert.ok(lastCapped!.pimg < lastInfinite!.pimg);
  assert.ok(capped.peak < infinite.peak);
});

test("compaction bounds the context and each request carries provider-only decoration only when enabled", () => {
  const params = { ...defaultParams(), batches: 16, budget: 1800, maxReq: 120, thresh: 60000 };
  const compacted = simulate(params, preset("legacy"));
  assert.ok(compacted.compactions > 0, "应至少触发一次压实");
  assert.equal(compacted.series.filter(point => point.compacted).length, compacted.compactions);
  assert.ok(compacted.peak < params.thresh * 1.5, "峰值应被阈值约束");
  const off = simulate(params, { ...preset("legacy"), omp: { ...preset("legacy").omp, dateCwd: false, schemas: false } });
  assert.equal(off.decoTok, 0);
  assert.ok(off.series.every(point => point.deco === 0));
  assert.ok(compacted.series.every(point => point.deco === compacted.decoTok && point.deco > 0));
});

test("the compaction marker belongs to the request that uses the compacted context", () => {
  const params = { ...defaultParams(), batches: 0, budget: 10, maxReq: 3, thresh: 1, keep: 0 };
  const result = simulate(params, preset("now"));
  assert.equal(result.requests, 3);
  assert.equal(result.compactions, 3);
  assert.deepEqual(result.series.map(point => [point.request, point.compacted, point.convo, point.ptext, point.pimg]), [
    [1, true, 1500, 0, 0], [2, true, 1500, 0, 0], [3, true, 1500, 0, 0],
  ]);
  assert.deepEqual(result.log.filter(event => event.ch === "compact").map(event => event.t), [2, 4, 6]);
  const disabled = simulate(params, { ...preset("now"), omp: { ...preset("now").omp, compaction: false } });
  assert.equal(disabled.compactions, 0);
  assert.ok(disabled.series.every(point => !point.compacted));
});

test("cumulative frame delivery survives compaction and wire caps and excludes state notices", () => {
  const params = { ...defaultParams(), batches: 16, budget: 1800, maxReq: 120, thresh: 60000 };
  const config = preset("legacy");
  const result = simulate(params, config);
  const capped = simulate(params, { ...config, omp: { ...config.omp, imgInf: false } });
  const uncompressed = simulate(params, { ...config, omp: { ...config.omp, compaction: false } });
  const delivered = result.log.filter(event => ["prompt_start", "tool_batch", "observe"].includes(event.ch));
  assert.equal(result.frames, delivered.length);
  assert.equal(result.frameTok, delivered.reduce((sum, event) => sum + event.tok, 0));
  assert.equal(result.frameTok, result.frames * (params.fText + params.fImg * params.iTok));
  assert.ok(result.compactions > 0);
  assert.ok(result.retainedPerceptionTok < result.frameTok);
  assert.equal(result.frameTok, uncompressed.frameTok);
  assert.equal(result.frameTok, capped.frameTok);
  assert.equal(result.retainedPerceptionTok, capped.retainedPerceptionTok);

  const stateOnly = simulate(defaultParams(), preset("pull"));
  assert.equal(stateOnly.frameTok, 0);
  assert.equal(stateOnly.retainedPerceptionTok, stateOnly.log.filter(event => event.ch === "state").reduce((sum, event) => sum + event.tok, 0));
  assert.ok(stateOnly.retainedPerceptionTok > 0);
});

test("explicit observe bypasses the newest-frame dedup that gates automatic delivery", () => {
  const params = { ...defaultParams(), hz: 0.01, batches: 4, budget: 120, maxReq: 40 };
  // 0.01Hz 时后续边界之间帧 id 不变:只有首轮 prompt_start 交付一次,其余全被去重拦下。
  const slow = simulate(params, preset("now"));
  assert.equal(slow.frames, 1);
  assert.equal(slow.gated, slow.rounds - 1, "其余轮首全部被最新帧去重拦下");
  const pulling = simulate({ ...params, obs: 1 }, preset("pull"));
  assert.equal(pulling.frames, pulling.rounds, "显式 observe 不受去重限制");
});

test("single-round presets preserve independently configured explicit observations", () => {
  const params = { ...defaultParams(), obs: 2 };
  const before = structuredClone(params);
  const bare = simulate(params, preset("bare"));
  assert.deepEqual(params, before);
  assert.equal(bare.rounds, 1);
  assert.equal(bare.frames, 2);
  assert.equal(bare.log.filter(event => event.ch === "observe").length, 2);
  assert.equal(bare.log.filter(event => ["prompt_start", "tool_batch", "state"].includes(event.ch)).length, 0);
});

test("the shared parameter schema covers every editable field exactly once", () => {
  const params = defaultParams();
  assert.deepEqual([...LOOP_PARAM_KEYS].sort(), Object.keys(params).sort());
  assert.deepEqual(PARAM_GROUPS.flatMap(group => group.items.map(item => item.key)).sort(), [...LOOP_PARAM_KEYS].sort());
  assert.deepEqual(validateLoopDraft(createLoopDraft(params)), { params, errors: {} });
  for (const key of LOOP_PARAM_KEYS) {
    const { min, max } = LOOP_PARAM_DEFS[key];
    assert.deepEqual(validateLoopParams({ ...params, [key]: min }).errors, {}, `${key} min`);
    assert.deepEqual(validateLoopParams({ ...params, [key]: max }).errors, {}, `${key} max`);
  }
});

test("draft validation preserves incomplete or non-decimal text and never substitutes a number", () => {
  for (const raw of ["", "-", ".", "600.", "1e3", "0x10", "NaN", "Infinity"]) {
    const draft = { ...createLoopDraft(defaultParams()), fText: raw };
    const result = validateLoopDraft(draft);
    assert.equal(result.params, null, raw);
    assert.equal(result.errors.fText?.code, raw === "" ? "required" : "number", raw);
    assert.equal(draft.fText, raw, "Validation does not rewrite the raw draft");
  }
});

test("draft validation accepts precise values independently of suggested steps and rejects fractional counts", () => {
  const draft = { ...createLoopDraft(defaultParams()), hz: ".01", changeRate: "0.0125", batchSec: "1.25", thresh: "10000000", fText: "301" };
  const result = validateLoopDraft(draft);
  assert.ok(result.params);
  assert.equal(result.params.hz, 0.01);
  assert.equal(result.params.changeRate, 0.0125);
  assert.equal(result.params.batchSec, 1.25);
  assert.equal(result.params.thresh, 10_000_000);
  assert.equal(result.params.fText, 301);
  assert.deepEqual(validateLoopDraft({ ...draft, fImg: "1.5" }).errors.fImg, { code: "integer" });
  assert.deepEqual(validateLoopDraft({ ...draft, changeRate: "-1" }).errors.changeRate, { code: "range", min: 0.01, max: 5 });
});

test("simulate fails before doing work for nonfinite, unsafe or out-of-domain parameters", () => {
  const params = defaultParams();
  for (const key of LOOP_PARAM_KEYS) {
    const definition = LOOP_PARAM_DEFS[key];
    for (const value of [NaN, Infinity, -Infinity, definition.min - 1, definition.max + 1]) {
      assert.throws(() => simulate({ ...params, [key]: value }, preset("now")), { name: "RangeError", message: new RegExp(`${key}:`) });
    }
    if (definition.integer) {
      assert.throws(() => simulate({ ...params, [key]: definition.min + 0.5 }, preset("now")), { name: "RangeError", message: new RegExp(`${key}: integer`) });
    }
  }
  // Previously a negative rate ran an unbounded backwards-time loop.
  assert.throws(() => simulate({ ...params, changeRate: -1 }, preset("now")), /changeRate: range/);
  for (const key of ["batchSec", "finalSec", "budget", "hz", "changeRate"] as const) {
    assert.throws(() => simulate({ ...params, [key]: 0 }, preset("now")), new RegExp(`${key}: range`));
  }
  assert.throws(() => simulate({ ...params, maxReq: undefined } as unknown as LoopParams, preset("now")), /maxReq: number/);
});

test("the largest accepted input workload stays bounded and deterministic", () => {
  const params = Object.fromEntries(LOOP_PARAM_KEYS.map(key => [key, LOOP_PARAM_DEFS[key].max])) as unknown as LoopParams;
  const first = simulate(params, preset("legacy"));
  assert.ok(first.requests <= params.maxReq);
  assert.ok(first.rounds <= params.maxReq + 1);
  assert.ok(first.series.every(point => Number.isFinite(point.total)));
  assert.deepEqual(simulate(params, preset("legacy")), first);
});
