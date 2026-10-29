"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  OMP_LAYER_DEFS, PRESETS, RSA_LAYER_DEFS, defaultParams, simulate,
  type LoopConfig, type LoopEvent, type LoopParams, type LoopResult, type SeriesPoint,
} from "@/lib/loop-lab";

const fmt = (n: number) => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

const PARAM_GROUPS: Array<{ title: string; items: Array<{ key: keyof LoopParams; label: string; unit: string; min: number; max: number; step?: number }> }> = [
  {
    title: "Loop 参数",
    items: [
      { key: "batches", label: "每轮工具批次", unit: "批", min: 0, max: 30 },
      { key: "batchSec", label: "批次耗时", unit: "s", min: 0.5, max: 30, step: 0.5 },
      { key: "finalSec", label: "收尾耗时", unit: "s", min: 1, max: 30 },
      { key: "budget", label: "时间预算", unit: "s", min: 30, max: 3600, step: 30 },
      { key: "maxReq", label: "请求预算", unit: "个", min: 1, max: 200 },
    ],
  },
  {
    title: "感知与环境",
    items: [
      { key: "hz", label: "采样率", unit: "Hz", min: 1, max: 60 },
      { key: "changeRate", label: "屏幕变化率", unit: "次/s", min: 0.01, max: 5, step: 0.01 },
      { key: "fText", label: "帧 JSON 文本", unit: "tok", min: 0, max: 2000, step: 50 },
      { key: "fImg", label: "每帧图片", unit: "张", min: 0, max: 4 },
      { key: "iTok", label: "单图成本", unit: "tok", min: 0, max: 4000, step: 50 },
      { key: "obs", label: "主动 observe", unit: "次/轮", min: 0, max: 10 },
    ],
  },
  {
    title: "Token 基线",
    items: [
      { key: "sysTpl", label: "OMP 系统模板", unit: "tok", min: 1000, max: 30000, step: 500 },
      { key: "agents", label: "AGENTS.md", unit: "tok", min: 0, max: 20000, step: 500 },
      { key: "schema", label: "工具 schema×6", unit: "tok", min: 0, max: 2000, step: 20 },
      { key: "remind", label: "date/cwd 提醒", unit: "tok", min: 0, max: 500, step: 10 },
      { key: "tool", label: "工具结果均值", unit: "tok", min: 100, max: 4000, step: 100 },
      { key: "asst", label: "助手消息均值", unit: "tok", min: 50, max: 2000, step: 50 },
      { key: "thresh", label: "compaction 阈值", unit: "tok", min: 20000, max: 400000, step: 5000 },
      { key: "keep", label: "保留近期", unit: "tok", min: 2000, max: 100000, step: 1000 },
      { key: "seed", label: "随机种子", unit: "#", min: 1, max: 9999 },
    ],
  },
];

const EVENT_ROLES: Partial<Record<LoopEvent["ch"], [string, string]>> = {
  system: ["系统提示(OMP+AGENTS)", "system"],
  user: ["用户消息", "system"],
  cont: ["continuation", "system"],
  assistant: ["助手", "system"],
  final: ["助手(收尾)", "system"],
  tool: ["工具结果", "system"],
  compact: ["⚡ compaction 摘要+保留近期", "system"],
  observe: ["🖼 observe(主动拉取)", "system"],
  state: ["感知状态通知", "system"],
  pruning: ["✂ 原生 pruning(工具结果)", "system"],
};

function Anatomy({ config }: { config: LoopConfig }) {
  const node = (label: string, on: boolean, kind: "rsa" | "nat") => (
    <span className={`loop-node ${on ? kind + "-on" : "off"}`}>{label}</span>
  );
  const arrow = <span className="loop-arrow">→</span>;
  return (
    <div className="loop-anatomy">
      <div className="loop-arow">
        <span className="loop-gname">OMP 内层(单次 prompt · 每次模型请求)</span>
        {node("prompt 准备", true, "nat")}{arrow}
        {node("① before_agent_start", config.rsa.ch1, "rsa")}{arrow}
        {node(`消息转换+装饰(${[config.omp.dateCwd && "date/cwd", config.omp.schemas && "schema"].filter(Boolean).join("") || "无"})`, config.omp.dateCwd || config.omp.schemas, "nat")}{arrow}
        {node("模型请求", true, "nat")}{arrow}
        {node("工具批次", true, "nat")}{arrow}
        {node("② tool_result 追加", config.rsa.ch2, "rsa")}{arrow}
        {node(`turn_end 检查(pruning${config.omp.compaction ? "/compaction" : ""})`, config.omp.pruning || config.omp.compaction, "nat")}
        <span className="loop-arrow">↻</span>
        {node("final", true, "nat")}
      </div>
      <div className="loop-arow">
        <span className="loop-gname">RSA 外层(仅接管时存在)</span>
        {node("final", true, "nat")}{arrow}
        {node("再发 continuation", config.rsa.cont, "rsa")}{arrow}
        {node("回到 prompt 准备", config.rsa.cont, "rsa")}
      </div>
    </div>
  );
}

function LoopChart({ series, thresh, onSelect }: { series: SeriesPoint[]; thresh: number; onSelect: (index: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 900;
    const height = 240;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 46, r: 10, t: 12, b: 20 };
    if (!series.length) {
      ctx.fillStyle = "#8b949e";
      ctx.font = "12px sans-serif";
      ctx.fillText("无模型请求(时间/请求预算耗尽前没有触发)", pad.l, height / 2);
      return;
    }
    const maxTotal = Math.max(...series.map(s => s.total), thresh) * 1.08;
    const n = series.length;
    const x = (i: number) => pad.l + (n === 1 ? (width - pad.l - pad.r) / 2 : (i / (n - 1)) * (width - pad.l - pad.r));
    const y = (t: number) => height - pad.b - (t / maxTotal) * (height - pad.t - pad.b);
    ctx.strokeStyle = "#30363d";
    ctx.fillStyle = "#8b949e";
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gt = maxTotal * g / 4;
      const gy = y(gt);
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(width - pad.r, gy);
      ctx.stroke();
      ctx.fillText(fmt(gt), 4, gy + 3);
    }
    ctx.strokeStyle = "#f85149";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y(thresh));
    ctx.lineTo(width - pad.r, y(thresh));
    ctx.stroke();
    ctx.setLineDash([]);
    const layers: Array<[keyof SeriesPoint, string]> = [
      ["sys", "#8b949e"], ["convo", "#a5d6ff"], ["tools", "#7ee787"], ["ptext", "#e3b341"], ["pimg", "#d29922"],
    ];
    const base = series.map(() => 0);
    for (const [key, color] of layers) {
      ctx.beginPath();
      series.forEach((s, i) => {
        const yy = y(base[i] + Number(s[key]));
        if (i) ctx.lineTo(x(i), yy);
        else ctx.moveTo(x(0), yy);
      });
      for (let i = series.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(base[i]));
      ctx.closePath();
      ctx.fillStyle = color + "cc";
      ctx.fill();
      for (let i = 0; i < n; i++) base[i] += Number(series[i][key]);
    }
    ctx.beginPath();
    series.forEach((s, i) => {
      const yy = y(base[i] + s.deco);
      if (i) ctx.lineTo(x(i), yy);
      else ctx.moveTo(x(0), yy);
    });
    ctx.strokeStyle = "#bc8cff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
    series.forEach((s, i) => {
      if (!s.compacted) return;
      ctx.strokeStyle = "#f85149";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x(i), pad.t);
      ctx.lineTo(x(i), height - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.fillStyle = "#8b949e";
    ctx.fillText(`模型请求 → (${n} 次 · 点选)`, pad.l, height - 5);
  }, [series, thresh]);
  return (
    <canvas
      ref={canvasRef}
      className="loop-chart"
      onClick={event => {
        if (!series.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const usable = rect.width - 46 - 10;
        const frac = Math.min(1, Math.max(0, (event.clientX - rect.left - 46) / Math.max(1, usable)));
        onSelect(Math.min(series.length, Math.max(1, Math.round(frac * (series.length - 1)) + 1)));
      }}
    />
  );
}

export function LoopLab() {
  const [params, setParams] = useState<LoopParams>(defaultParams);
  const [config, setConfig] = useState<LoopConfig>(PRESETS[0]!.cfg);
  const [presetId, setPresetId] = useState<string>(PRESETS[0]!.id);
  const [selected, setSelected] = useState(1);

  const results = useMemo(() => {
    const main = simulate(params, config);
    return { main, all: PRESETS.map(p => ({ preset: p, result: simulate(params, p.cfg) })) };
  }, [params, config]);
  const { main } = results;

  useEffect(() => {
    setSelected(previous => Math.min(previous, Math.max(1, main.series.length)));
  }, [main.series.length]);

  const activePreset = PRESETS.find(p => JSON.stringify(p.cfg) === JSON.stringify(config)) ?? null;
  const setParam = (key: keyof LoopParams, value: number) =>
    setParams(previous => ({ ...previous, [key]: value }));
  const applyPreset = (id: string) => {
    const preset = PRESETS.find(p => p.id === id);
    if (!preset) return;
    setConfig(preset.cfg);
    setParams(previous => ({ ...previous, obs: preset.cfg.rsa.cont || id !== "bare" ? previous.obs : 0 }));
    setPresetId(id);
  };
  const toggle = (group: "rsa" | "omp", key: string, value: boolean) => {
    setConfig(previous => ({ ...previous, [group]: { ...previous[group], [key]: value } }));
    setPresetId(activePreset?.id ?? "");
  };

  const peakRequest = main.series.length ? main.series.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const framePct = peakRequest ? Math.round(((peakRequest.ptext + peakRequest.pimg) / peakRequest.total) * 100) : 0;
  const selectedPoint = main.series[Math.min(selected, main.series.length) - 1];
  const history = main.log.slice(-250);
  const hiddenCount = main.log.length - history.length;
  const maxFrame = Math.max(1, ...results.all.map(r => r.result.frameTok));

  const stats: Array<{ k: string; v: string; cls: string }> = [
    { k: "模型请求 / 预算", v: `${main.requests}/${params.maxReq}`, cls: "" },
    { k: "接管轮数", v: String(main.rounds), cls: "" },
    { k: "注入帧数", v: String(main.frames), cls: main.frames > main.requests ? "warn" : "good" },
    { k: "帧 token(交付)", v: fmt(main.frameTok), cls: "warn" },
    { k: "峰值 wire", v: fmt(main.peak), cls: main.peak >= params.thresh && config.omp.compaction ? "bad" : main.peak >= params.thresh ? "warn" : "" },
    { k: "帧占峰值", v: framePct + "%", cls: framePct > 30 ? "bad" : framePct > 10 ? "warn" : "good" },
    { k: "compaction", v: `${main.compactions} 次`, cls: main.compactions ? "warn" : "good" },
    { k: "装饰/请求", v: config.omp.dateCwd || config.omp.schemas ? fmt(main.decoTok) + " tok" : "0", cls: "" },
  ];

  return (
    <section className="loop-lab">
      <div className="loop-presets">
        {PRESETS.map(p => (
          <button
            key={p.id}
            className={`loop-preset ${p.legacy ? "legacy" : ""} ${(activePreset?.id ?? presetId) === p.id ? "active" : ""}`}
            onClick={() => applyPreset(p.id)}
          >
            <b>{p.name}</b>
            {p.legacy && <i>已删 · 鞭尸用</i>}
            <span>{p.desc}</span>
          </button>
        ))}
      </div>

      <div className="loop-layout">
        <div className="loop-side">
          <div className="loop-card">
            <h3>RSA 注入层 ①②</h3>
            {RSA_LAYER_DEFS.map(layer => (
              <label key={layer.key} className={`loop-layer rsa ${layer.key === "ch2" ? "legacy-layer" : ""}`}>
                <input
                  type="checkbox"
                  checked={config.rsa[layer.key]}
                  onChange={e => toggle("rsa", layer.key, e.target.checked)}
                />
                <span><b>{layer.name}</b><small>{layer.desc}</small></span>
              </label>
            ))}
          </div>
          <div className="loop-card">
            <h3>OMP 原生层</h3>
            {OMP_LAYER_DEFS.map(layer => (
              <label key={layer.key} className="loop-layer">
                <input
                  type="checkbox"
                  checked={config.omp[layer.key]}
                  onChange={e => toggle("omp", layer.key, e.target.checked)}
                />
                <span><b>{layer.name}</b><small>{layer.desc}</small></span>
              </label>
            ))}
            <label className="loop-param">
              <span>原生图片上限</span>
              <input
                type="number"
                min={1}
                max={200}
                value={params.imgCap}
                disabled={config.omp.imgInf}
                onChange={e => setParam("imgCap", Number(e.target.value))}
              />
              <small>张</small>
            </label>
          </div>
          {PARAM_GROUPS.map(group => (
            <div key={group.title} className="loop-card">
              <h3>{group.title}</h3>
              {group.items.map(item => (
                <label key={item.key} className="loop-param">
                  <span>{item.label}</span>
                  <input
                    type="number"
                    min={item.min}
                    max={item.max}
                    step={item.step ?? 1}
                    value={params[item.key]}
                    onChange={e => setParam(item.key, Number(e.target.value))}
                  />
                  <small>{item.unit}</small>
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="loop-main">
          <div className="loop-card">
            <h3>循环解剖(紫=OMP 原生 · 琥珀=RSA 注入 · 划掉=当前已关)</h3>
            <Anatomy config={config} />
          </div>
          <div className="loop-stats">
            {stats.map(s => (
              <div key={s.k} className="loop-stat">
                <span className="k">{s.k}</span>
                <span className={`v ${s.cls}`}>{s.v}</span>
              </div>
            ))}
          </div>
          <div className="loop-card">
            <h3>Wire 构成 · 每次模型请求实际发送的 token(点图可选请求)</h3>
            <LoopChart series={main.series} thresh={params.thresh} onSelect={setSelected} />
            <div className="loop-legend">
              <span><i style={{ background: "var(--loop-sys)" }} />系统(模板+AGENTS)</span>
              <span><i style={{ background: "var(--loop-convo)" }} />对话(user/assistant)</span>
              <span><i style={{ background: "var(--loop-tools)" }} />工具结果</span>
              <span><i style={{ background: "var(--loop-ptext)" }} />感知 JSON</span>
              <span><i style={{ background: "var(--loop-pimg)" }} />感知图片(wire)</span>
              <span><i style={{ background: "var(--loop-native)" }} />─ 每请求装饰(不入历史)</span>
              <span><i style={{ background: "var(--loop-danger)" }} />│ compaction</span>
            </div>
            <div className="loop-compare">
              {results.all.map(({ preset, result }) => (
                <button
                  key={preset.id}
                  className={`loop-cmp ${preset.legacy ? "legacy" : ""} ${(activePreset?.id ?? presetId) === preset.id ? "active" : ""}`}
                  onClick={() => applyPreset(preset.id)}
                >
                  <b>{preset.name}</b>
                  <span>帧 {result.frames} · <strong>{fmt(result.frameTok)} tok</strong></span>
                  <span>峰值 {fmt(result.peak)} · 压实 {result.compactions} 次</span>
                  <span className="bar"><i style={{ width: `${Math.round((result.frameTok / maxFrame) * 100)}%` }} /></span>
                </button>
              ))}
            </div>
          </div>
          <div className="loop-card">
            <div className="loop-insp-head">
              <h3>Wire 检查器</h3>
              <input
                type="range"
                min={1}
                max={Math.max(1, main.series.length)}
                value={Math.min(selected, Math.max(1, main.series.length))}
                onChange={e => setSelected(Number(e.target.value))}
              />
              <b>请求 #{selectedPoint ? selectedPoint.request : "—"}</b>
            </div>
            {selectedPoint ? (
              <div className="loop-wire">
                <div>
                  <h4 style={{ color: "var(--loop-native)" }}>系统层(每请求都有)</h4>
                  <p><i style={{ background: "var(--loop-sys)" }} />OMP 系统模板<b>{fmt(params.sysTpl)} tok</b></p>
                  {config.omp.agents && <p><i style={{ background: "var(--loop-sys)" }} />AGENTS.md (RSA contextFiles)<b>{fmt(params.agents)} tok</b></p>}
                  <p className="total">小计<b>{fmt(selectedPoint.sys)} tok</b></p>
                </div>
                <div>
                  <h4 style={{ color: "var(--loop-convo)" }}>持久历史层(累积)</h4>
                  <p><i style={{ background: "var(--loop-convo)" }} />对话 user/assistant<b>{fmt(selectedPoint.convo)} tok</b></p>
                  <p><i style={{ background: "var(--loop-tools)" }} />工具结果<b>{fmt(selectedPoint.tools)} tok</b></p>
                  <p><i style={{ background: "var(--loop-ptext)" }} />感知 JSON(RSA)<b>{fmt(selectedPoint.ptext)} tok</b></p>
                  <p>
                    <i style={{ background: "var(--loop-pimg)" }} />
                    感知图片(RSA · wire {selectedPoint.imgShown}{!config.omp.imgInf && ` / 共 ${selectedPoint.imgTotal} 张,原生裁掉旧图`})
                    <b>{fmt(selectedPoint.pimg)} tok</b>
                  </p>
                  <p className="total">历史合计(含系统)<b>{fmt(selectedPoint.hist)} tok</b></p>
                </div>
                <div>
                  <h4 style={{ color: "var(--loop-native)" }}>每请求装饰层(provider-only · 不入历史)</h4>
                  {config.omp.dateCwd && <p><i style={{ background: "var(--loop-native)" }} />date/cwd 提醒<b>{fmt(params.remind)} tok</b></p>}
                  {config.omp.schemas && <p><i style={{ background: "var(--loop-native)" }} />工具 schema×6(含 i 字段)<b>{fmt(params.schema)} tok</b></p>}
                  <p className="total">装饰小计<b>{fmt(selectedPoint.deco)} tok</b></p>
                  <p className="total grand">本次请求 wire 总计<b>{fmt(selectedPoint.total)} tok</b></p>
                </div>
              </div>
            ) : (
              <p className="loop-empty">无请求可检查。</p>
            )}
          </div>
          <div className="loop-card">
            <h3>持久消息历史(最新 250 条 · 装饰层不进历史,只在 wire 里)</h3>
            <div className="loop-history">
              {hiddenCount > 0 && <p className="loop-hidden">⋯ {hiddenCount} 条更早的消息已滑出视图</p>}
              {history.map((event, index) => (
                <HistoryRow key={index} event={event} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="loop-foot">
        估算模型,供策略对照。机制依据:<code>rsa/src/harness/omp/session.ts:128-140</code> 外层循环 ·
        <code>extension.ts:252-265</code> 轮首注入 · 通道②(批次末注入)已于 2026-10-29 删除,见
        <code>docs/insights/omp-injection.md</code>。
      </p>
    </section>
  );
}

function HistoryRow({ event }: { event: LoopEvent }) {
  let role: string;
  let cls: string;
  if (event.ch === "prompt_start") {
    role = "🖼 感知注入①轮首";
    cls = "pstart";
  } else if (event.ch === "tool_batch") {
    role = "🖼 感知注入②批次末(已删)";
    cls = "pbatch legacy-row";
  } else {
    const mapped = EVENT_ROLES[event.ch];
    role = mapped ? mapped[0] : event.ch;
    cls = mapped ? mapped[1] : "system";
  }
  const badge = event.changed === true ? "屏幕有变化" : event.changed === false ? "屏幕没变" : "";
  const tokens = event.tok !== 0 ? `${event.tok > 0 ? "+" : "−"}${fmt(Math.abs(event.tok))} tok` : "";
  return (
    <div className={`loop-msg ${cls}`}>
      <span className={`loop-src ${event.omp ? "omp" : "rsa"}`}>{event.omp ? "OMP" : "RSA"}</span>
      <span className="loop-role">{role}{badge && <i>{badge}</i>}</span>
      <span className="loop-tok">{tokens} · {Math.round(event.t)}s</span>
    </div>
  );
}
