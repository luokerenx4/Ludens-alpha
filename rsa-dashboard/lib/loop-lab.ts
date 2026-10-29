/** Loop 注入实验台的纯模拟核心:预设、参数与一次接管的上下文推演。 */

export interface LoopParams {
  batches: number;
  batchSec: number;
  finalSec: number;
  budget: number;
  maxReq: number;
  hz: number;
  changeRate: number;
  fText: number;
  fImg: number;
  iTok: number;
  obs: number;
  sysTpl: number;
  agents: number;
  schema: number;
  remind: number;
  tool: number;
  asst: number;
  thresh: number;
  keep: number;
  seed: number;
  imgCap: number;
}

export interface RsaLayers {
  ch1: boolean;
  ch2: boolean;
  gate: boolean;
  state: boolean;
  cont: boolean;
}

export interface OmpLayers {
  agents: boolean;
  dateCwd: boolean;
  schemas: boolean;
  pruning: boolean;
  compaction: boolean;
  imgInf: boolean;
}

export interface LoopConfig {
  rsa: RsaLayers;
  omp: OmpLayers;
}

export interface SeriesPoint {
  sys: number;
  convo: number;
  tools: number;
  ptext: number;
  pimg: number;
  deco: number;
  hist: number;
  imgShown: number;
  imgTotal: number;
  total: number;
  compacted: boolean;
  request: number;
}

export type LoopEventChannel =
  | "system" | "user" | "cont" | "assistant" | "final" | "tool"
  | "prompt_start" | "tool_batch" | "observe" | "state" | "compact" | "pruning";

export interface LoopEvent {
  ch: LoopEventChannel;
  tok: number;
  changed?: boolean;
  t: number;
  omp: boolean;
}

export interface LoopResult {
  series: SeriesPoint[];
  frames: number;
  gated: number;
  compactions: number;
  pruned: number;
  requests: number;
  rounds: number;
  log: LoopEvent[];
  peak: number;
  frameTok: number;
  decoTok: number;
}

export interface LoopPreset {
  id: string;
  name: string;
  desc: string;
  /** 已删除的历史行为,仅供对照("鞭尸"),不再是现状。 */
  legacy?: boolean;
  cfg: LoopConfig;
}

export const PRESETS: LoopPreset[] = [
  {
    id: "now", name: "现状", desc: "仅轮首自动交付,轮内靠显式 observe",
    cfg: { rsa: { ch1: true, ch2: false, gate: false, state: true, cont: true }, omp: { agents: true, dateCwd: true, schemas: true, pruning: true, compaction: true, imgInf: true } },
  },
  {
    id: "legacy", name: "旧·批次末注入", desc: "每工具批次末追加最新帧(2026-10-29 已删)", legacy: true,
    cfg: { rsa: { ch1: true, ch2: true, gate: false, state: true, cont: true }, omp: { agents: true, dateCwd: true, schemas: true, pruning: true, compaction: true, imgInf: true } },
  },
  {
    id: "gate", name: "语义门控", desc: "边界同旧,但屏幕没变不推(假想)",
    cfg: { rsa: { ch1: true, ch2: true, gate: true, state: true, cont: true }, omp: { agents: true, dateCwd: true, schemas: true, pruning: true, compaction: true, imgInf: true } },
  },
  {
    id: "pull", name: "纯拉取", desc: "关自动注入,模型按需 observe",
    cfg: { rsa: { ch1: false, ch2: false, gate: false, state: true, cont: true }, omp: { agents: true, dateCwd: true, schemas: true, pruning: true, compaction: true, imgInf: true } },
  },
  {
    id: "bare", name: "裸 OMP", desc: "无 RSA 接管的原始 OMP 单轮会话",
    cfg: { rsa: { ch1: false, ch2: false, gate: false, state: false, cont: false }, omp: { agents: true, dateCwd: true, schemas: true, pruning: true, compaction: true, imgInf: false } },
  },
];

export const RSA_LAYER_DEFS: Array<{ key: keyof RsaLayers; name: string; desc: string }> = [
  { key: "ch1", name: "通道① · 轮首注入", desc: "before_agent_start:每轮 prompt 开始推最新帧" },
  { key: "ch2", name: "通道② · 批次末注入", desc: "每个工具批次结束追加到最后一个 tool result(已删除,仅模拟)" },
  { key: "gate", name: "语义门控(假想)", desc: "屏幕无变化则跳过——代码从未实现过此能力" },
  { key: "state", name: "感知状态通知", desc: "sampler 状态变化时的小 JSON(约120 tok)" },
  { key: "cont", name: "外层 continuation 循环", desc: "final 后再发一轮;关掉=普通单次 OMP 会话" },
];

export const OMP_LAYER_DEFS: Array<{ key: keyof OmpLayers; name: string; desc: string }> = [
  { key: "agents", name: "AGENTS.md → contextFiles", desc: "进系统提示 project block" },
  { key: "dateCwd", name: "date/cwd 提醒", desc: "provider-only,每次请求临时加,不入历史" },
  { key: "schemas", name: "工具 schema(含 i 字段)", desc: "provider-only,6 个工具定义每次请求都发" },
  { key: "pruning", name: "原生 pruning", desc: "新 read 替换旧 read / elide 已消费结果" },
  { key: "compaction", name: "自动 compaction", desc: "超阈值压成摘要+保留近期" },
  { key: "imgInf", name: "图片预算 ∞(RSA 覆盖)", desc: "关掉=OMP 原生上限(如 DeepSeek 保留 5 张)" },
];

export function defaultParams(): LoopParams {
  return {
    batches: 8, batchSec: 3, finalSec: 2, budget: 300, maxReq: 30,
    hz: 30, changeRate: 0.15, fText: 300, fImg: 1, iTok: 1100, obs: 0,
    sysTpl: 3500, agents: 2500, schema: 380, remind: 40,
    tool: 800, asst: 250, thresh: 110000, keep: 20000, seed: 7, imgCap: 5,
  };
}

export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 推演一次接管:返回每次模型请求的 wire 构成与注入事件日志。 */
export function simulate(p: LoopParams, c: LoopConfig): LoopResult {
  const rnd = mulberry32(p.seed * 1013);
  const changeTimes: number[] = [];
  let t = 0;
  while (t < p.budget + 60) {
    t += -Math.log(1 - rnd() * 0.999) / p.changeRate;
    changeTimes.push(t);
  }

  const imgCap = c.omp.imgInf ? Infinity : p.imgCap;
  const sysTok = p.sysTpl + (c.omp.agents ? p.agents : 0);
  const decoTok = (c.omp.dateCwd ? p.remind : 0) + (c.omp.schemas ? p.schema : 0);
  const convo = { tokens: 0 }, tools = { tokens: 0 }, ptext = { tokens: 0 };
  const images: number[] = [];
  const series: SeriesPoint[] = [];
  const log: LoopEvent[] = [];
  let frames = 0, gated = 0, compactions = 0, pruned = 0, requests = 0, rounds = 0;
  let now = 0, lastBoundary = 0, lastMain = -1;
  const histTotal = () => sysTok + convo.tokens + tools.tokens + ptext.tokens + images.reduce((a, b) => a + b, 0);
  const injectFrame = (ch: LoopEventChannel, tB: number): boolean => {
    // 屏幕语义变化窗口 = (上次交付边界, 本次边界];门控开启且无变化则跳过。
    const changed = changeTimes.some(x => x > Math.max(lastBoundary, 0) && x <= tB);
    if (c.rsa.gate && !changed && tB > 0) {
      gated++; lastBoundary = tB;
      return false;
    }
    frames++;
    ptext.tokens += p.fText;
    for (let i = 0; i < p.fImg; i++) images.push(p.iTok);
    log.push({ ch, tok: p.fText + p.fImg * p.iTok, changed, t: tB, omp: false });
    lastBoundary = tB;
    return true;
  };
  const maybeInject = (ch: LoopEventChannel, tB: number) => {
    if (ch === "prompt_start" && !c.rsa.ch1) return;
    if (ch === "tool_batch" && !c.rsa.ch2) return;
    // 与 extension.ts 相同的去重:自动通道只在最新主样本 id 变化时交付。
    const newest = Math.floor(tB * p.hz);
    if (newest === lastMain) {
      gated++;
      return;
    }
    if (injectFrame(ch, tB)) lastMain = newest;
  };
  const compactIfNeeded = () => {
    if (!c.omp.compaction || histTotal() < p.thresh) return;
    compactions++;
    const keepFrac = Math.min(1, p.keep / Math.max(1, histTotal() - sysTok));
    convo.tokens = Math.round(convo.tokens * keepFrac) + 1500;
    tools.tokens = Math.round(tools.tokens * keepFrac);
    ptext.tokens = Math.round(ptext.tokens * keepFrac);
    images.length = Math.round(images.length * keepFrac);
    log.push({ ch: "compact", tok: 0, t: now, omp: true });
  };
  const request = () => {
    compactIfNeeded();
    requests++;
    const pimg = images.slice(-imgCap).reduce((a, b) => a + b, 0);
    series.push({
      sys: sysTok, convo: convo.tokens, tools: tools.tokens, ptext: ptext.tokens,
      pimg, deco: decoTok,
      imgShown: Math.min(images.length, imgCap === Infinity ? images.length : imgCap),
      imgTotal: images.length,
      hist: sysTok + convo.tokens + tools.tokens + ptext.tokens + images.reduce((a, b) => a + b, 0),
      total: sysTok + convo.tokens + tools.tokens + ptext.tokens + pimg + decoTok,
      compacted: false, request: requests,
    });
  };

  log.push({ ch: "system", tok: sysTok, t: 0, omp: true });
  outer: while (now < p.budget && requests < p.maxReq) {
    rounds++;
    maybeInject("prompt_start", now);
    convo.tokens += rounds === 1 ? 120 : 20;
    log.push({ ch: rounds === 1 ? "user" : "cont", tok: rounds === 1 ? 120 : 20, t: now, omp: true });
    for (let b = 0; b < p.batches; b++) {
      now += p.batchSec;
      if (now >= p.budget || requests >= p.maxReq) break outer;
      request();
      convo.tokens += p.asst;
      log.push({ ch: "assistant", tok: p.asst, t: now, omp: true });
      tools.tokens += p.tool;
      log.push({ ch: "tool", tok: p.tool, t: now, omp: true });
      if (p.obs > 0 && b % Math.max(1, Math.ceil(p.batches / p.obs)) === 0) {
        if (injectFrame("observe", now)) lastMain = Math.floor(now * p.hz);
      } else {
        maybeInject("tool_batch", now);
      }
      if (c.rsa.state && b === Math.floor(p.batches / 2) && rounds <= 2) {
        ptext.tokens += 120;
        log.push({ ch: "state", tok: 120, t: now, omp: false });
      }
      if (c.omp.pruning && requests % 6 === 0 && tools.tokens > 2000) {
        const cut = Math.round(tools.tokens * 0.25);
        tools.tokens -= cut;
        pruned += cut;
        log.push({ ch: "pruning", tok: -cut, t: now, omp: true });
      }
    }
    now += p.finalSec;
    if (now < p.budget && requests < p.maxReq) {
      request();
      convo.tokens += p.asst;
      log.push({ ch: "final", tok: p.asst, t: now, omp: true });
    }
    if (!c.rsa.cont) break;
  }
  return {
    series, frames, gated, compactions, pruned, requests, rounds, log,
    peak: Math.max(0, ...series.map(s => s.total)),
    frameTok: ptext.tokens + images.reduce((a, b) => a + b, 0),
    decoTok,
  };
}
