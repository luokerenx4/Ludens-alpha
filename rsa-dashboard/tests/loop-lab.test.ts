import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, defaultParams, simulate } from "../lib/loop-lab";

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
  assert.ok(compacted.peak < params.thresh * 1.5, "峰值应被阈值约束");
  const off = simulate(params, { ...preset("legacy"), omp: { ...preset("legacy").omp, dateCwd: false, schemas: false } });
  assert.equal(off.decoTok, 0);
  assert.ok(off.series.every(point => point.deco === 0));
  assert.ok(compacted.series.every(point => point.deco === compacted.decoTok && point.deco > 0));
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
