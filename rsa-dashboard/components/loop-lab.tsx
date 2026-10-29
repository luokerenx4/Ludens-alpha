"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/lib/locale";
import {
  OMP_LAYER_DEFS, PRESETS, RSA_LAYER_DEFS, defaultParams, simulate,
  type LoopConfig, type LoopEvent, type LoopParams, type LoopResult, type SeriesPoint,
} from "@/lib/loop-lab";

const fmt = (n: number) => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

const PARAM_GROUPS: Array<{ title: string; items: Array<{ key: keyof LoopParams; min: number; max: number; step?: number }> }> = [
  {
    title: "loop",
    items: [
      { key: "batches", min: 0, max: 30 },
      { key: "batchSec", min: 0.5, max: 30, step: 0.5 },
      { key: "finalSec", min: 1, max: 30 },
      { key: "budget", min: 30, max: 3600, step: 30 },
      { key: "maxReq", min: 1, max: 200 },
    ],
  },
  {
    title: "env",
    items: [
      { key: "hz", min: 1, max: 60 },
      { key: "changeRate", min: 0.01, max: 5, step: 0.01 },
      { key: "fText", min: 0, max: 2000, step: 50 },
      { key: "fImg", min: 0, max: 4 },
      { key: "iTok", min: 0, max: 4000, step: 50 },
      { key: "obs", min: 0, max: 10 },
    ],
  },
  {
    title: "baseline",
    items: [
      { key: "sysTpl", min: 1000, max: 30000, step: 500 },
      { key: "agents", min: 0, max: 20000, step: 500 },
      { key: "schema", min: 0, max: 2000, step: 20 },
      { key: "remind", min: 0, max: 500, step: 10 },
      { key: "tool", min: 100, max: 4000, step: 100 },
      { key: "asst", min: 50, max: 2000, step: 50 },
      { key: "thresh", min: 20000, max: 400000, step: 5000 },
      { key: "keep", min: 2000, max: 100000, step: 1000 },
      { key: "seed", min: 1, max: 9999 },
    ],
  },
];

const EVENT_ROLE_KEYS: Partial<Record<LoopEvent["ch"], string>> = {
  system: "roles.system",
  user: "roles.user",
  assistant: "roles.assistant",
  final: "roles.final",
  tool: "roles.tool",
  compact: "roles.compact",
  observe: "roles.observe",
  state: "roles.state",
  pruning: "roles.pruning",
};

function Anatomy({ config }: { config: LoopConfig }) {
  const t = useTranslations("loopLab");
  const node = (label: string, on: boolean, kind: "rsa" | "nat") => (
    <span className={`loop-node ${on ? kind + "-on" : "off"}`}>{label}</span>
  );
  const arrow = <span className="loop-arrow">→</span>;
  return (
    <div className="loop-anatomy">
      <div className="loop-arow">
        <span className="loop-gname">{t("anatomy.inner")}</span>
        {node(t("anatomy.promptPrep"), true, "nat")}{arrow}
        {node("① before_agent_start", config.rsa.ch1, "rsa")}{arrow}
        {node(`${t("anatomy.transform")}(${
          [config.omp.dateCwd && "date/cwd", config.omp.schemas && "schema"].filter(Boolean).join("") || t("anatomy.none")
        })`, config.omp.dateCwd || config.omp.schemas, "nat")}{arrow}
        {node(t("anatomy.modelRequest"), true, "nat")}{arrow}
        {node(t("anatomy.toolBatch"), true, "nat")}{arrow}
        {node(t("anatomy.appendTools"), config.rsa.ch2, "rsa")}{arrow}
        {node(`turn_end ${t("anatomy.turnEndCheck")}(pruning${config.omp.compaction ? "/compaction" : ""})`, config.omp.pruning || config.omp.compaction, "nat")}
        <span className="loop-arrow">↻</span>
        {node("final", true, "nat")}
      </div>
      <div className="loop-arow">
        <span className="loop-gname">{t("anatomy.outer")}</span>
        {node("final", true, "nat")}{arrow}
        {node(t("anatomy.resendCont"), config.rsa.cont, "rsa")}{arrow}
        {node(t("anatomy.backToPrep"), config.rsa.cont, "rsa")}
      </div>
    </div>
  );
}

function LoopChart({ series, thresh, onSelect }: { series: SeriesPoint[]; thresh: number; onSelect: (index: number) => void }) {
  const t = useTranslations("loopLab");
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
      ctx.fillText(t("chart.empty"), pad.l, height / 2);
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
    ctx.fillText(`${t("chart.requests")} → (${n} ${t("chart.clickHint")})`, pad.l, height - 5);
  }, [series, thresh, t]);
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
  const t = useTranslations("loopLab");
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
    { k: t("stats.requests"), v: `${main.requests}/${params.maxReq}`, cls: "" },
    { k: t("stats.rounds"), v: String(main.rounds), cls: "" },
    { k: t("stats.frames"), v: String(main.frames), cls: main.frames > main.requests ? "warn" : "good" },
    { k: t("stats.frameTok"), v: fmt(main.frameTok), cls: "warn" },
    { k: t("stats.peak"), v: fmt(main.peak), cls: main.peak >= params.thresh && config.omp.compaction ? "bad" : main.peak >= params.thresh ? "warn" : "" },
    { k: t("stats.frameShare"), v: framePct + "%", cls: framePct > 30 ? "bad" : framePct > 10 ? "warn" : "good" },
    { k: t("stats.compactions"), v: `${main.compactions} ${t("stats.times")}`, cls: main.compactions ? "warn" : "good" },
    { k: t("stats.decoPerReq"), v: config.omp.dateCwd || config.omp.schemas ? fmt(main.decoTok) + " tok" : "0", cls: "" },
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
            {p.legacy && <i>{t("presets.legacyTag")}</i>}
            <span>{p.desc}</span>
          </button>
        ))}
      </div>

      <div className="loop-layout">
        <div className="loop-side">
          <div className="loop-card">
            <h3>{t("cards.rsa")}</h3>
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
            <h3>{t("cards.omp")}</h3>
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
              <span>{t("cards.imgCap")}</span>
              <input
                type="number"
                min={1}
                max={200}
                value={params.imgCap}
                disabled={config.omp.imgInf}
                onChange={e => setParam("imgCap", Number(e.target.value))}
              />
              <small>{t("units.imgCap")}</small>
            </label>
          </div>
          {PARAM_GROUPS.map(group => (
            <div key={group.title} className="loop-card">
              <h3>{t(`groups.${group.title}`)}</h3>
              {group.items.map(item => (
                <label key={item.key} className="loop-param">
                  <span>{t(`params.${item.key}`)}</span>
                  <input
                    type="number"
                    min={item.min}
                    max={item.max}
                    step={item.step ?? 1}
                    value={params[item.key]}
                    onChange={e => setParam(item.key, Number(e.target.value))}
                  />
                  <small>{t(`units.${item.key}`)}</small>
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="loop-main">
          <div className="loop-card">
            <h3>{t("cards.anatomy")}</h3>
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
            <h3>{t("cards.wire")}</h3>
            <LoopChart series={main.series} thresh={params.thresh} onSelect={setSelected} />
            <div className="loop-legend">
              <span><i style={{ background: "var(--loop-sys)" }} />{t("legend.sys")}</span>
              <span><i style={{ background: "var(--loop-convo)" }} />{t("legend.convo")}</span>
              <span><i style={{ background: "var(--loop-tools)" }} />{t("legend.tools")}</span>
              <span><i style={{ background: "var(--loop-ptext)" }} />{t("legend.ptext")}</span>
              <span><i style={{ background: "var(--loop-pimg)" }} />{t("legend.pimg")}</span>
              <span><i style={{ background: "var(--loop-native)" }} />{t("legend.deco")}</span>
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
                  <span>{t("compare.frames")} {result.frames} · <strong>{fmt(result.frameTok)} tok</strong></span>
                  <span>{t("compare.peak")} {fmt(result.peak)} · {t("compare.compactions")} {result.compactions} {t("stats.times")}</span>
                  <span className="bar"><i style={{ width: `${Math.round((result.frameTok / maxFrame) * 100)}%` }} /></span>
                </button>
              ))}
            </div>
          </div>
          <div className="loop-card">
            <div className="loop-insp-head">
              <h3>{t("cards.inspector")}</h3>
              <input
                type="range"
                min={1}
                max={Math.max(1, main.series.length)}
                value={Math.min(selected, Math.max(1, main.series.length))}
                onChange={e => setSelected(Number(e.target.value))}
              />
              <b>{t("inspector.request")} #{selectedPoint ? selectedPoint.request : "—"}</b>
            </div>
            {selectedPoint ? (
              <div className="loop-wire">
                <div>
                  <h4 style={{ color: "var(--loop-native)" }}>{t("wire.sysLayer")}</h4>
                  <p><i style={{ background: "var(--loop-sys)" }} />{t("wire.ompTpl")}<b>{fmt(params.sysTpl)} tok</b></p>
                  {config.omp.agents && <p><i style={{ background: "var(--loop-sys)" }} />AGENTS.md (RSA contextFiles)<b>{fmt(params.agents)} tok</b></p>}
                  <p className="total">{t("wire.subtotal")}<b>{fmt(selectedPoint.sys)} tok</b></p>
                </div>
                <div>
                  <h4 style={{ color: "var(--loop-convo)" }}>{t("wire.histLayer")}</h4>
                  <p><i style={{ background: "var(--loop-convo)" }} />{t("wire.convo")}<b>{fmt(selectedPoint.convo)} tok</b></p>
                  <p><i style={{ background: "var(--loop-tools)" }} />{t("wire.tools")}<b>{fmt(selectedPoint.tools)} tok</b></p>
                  <p><i style={{ background: "var(--loop-ptext)" }} />{t("wire.ptext")}<b>{fmt(selectedPoint.ptext)} tok</b></p>
                  <p>
                    <i style={{ background: "var(--loop-pimg)" }} />
                    {t("wire.pimg")}(RSA · wire {selectedPoint.imgShown}{!config.omp.imgInf && ` / ${t("wire.ofTotal")} ${selectedPoint.imgTotal} ${t("wire.trimmed")}`})
                    <b>{fmt(selectedPoint.pimg)} tok</b>
                  </p>
                  <p className="total">{t("wire.histTotal")}<b>{fmt(selectedPoint.hist)} tok</b></p>
                </div>
                <div>
                  <h4 style={{ color: "var(--loop-native)" }}>{t("wire.decoLayer")}</h4>
                  {config.omp.dateCwd && <p><i style={{ background: "var(--loop-native)" }} />{t("wire.dateCwd")}<b>{fmt(params.remind)} tok</b></p>}
                  {config.omp.schemas && <p><i style={{ background: "var(--loop-native)" }} />{t("wire.schemas")}<b>{fmt(params.schema)} tok</b></p>}
                  <p className="total">{t("wire.decoSubtotal")}<b>{fmt(selectedPoint.deco)} tok</b></p>
                  <p className="total grand">{t("wire.grandTotal")}<b>{fmt(selectedPoint.total)} tok</b></p>
                </div>
              </div>
            ) : (
              <p className="loop-empty">{t("wire.empty")}</p>
            )}
          </div>
          <div className="loop-card">
            <h3>{t("cards.history")}</h3>
            <div className="loop-history">
              {hiddenCount > 0 && <p className="loop-hidden">⋯ {hiddenCount} {t("history.hiddenSuffix")}</p>}
              {history.map((event, index) => (
                <HistoryRow key={index} event={event} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="loop-foot">
        {t("foot.prefix")}<code>rsa/src/harness/omp/session.ts:128-140</code> {t("foot.outer")} ·
        <code>extension.ts:252-265</code> {t("foot.roundStart")} · {t("foot.ch2removed")}
        <code>docs/insights/omp-injection.md</code>。
      </p>
    </section>
  );
}

function HistoryRow({ event }: { event: LoopEvent }) {
  const t = useTranslations("loopLab");
  let role: string;
  let cls: string;
  if (event.ch === "prompt_start") {
    role = t("history.promptStart");
    cls = "pstart";
  } else if (event.ch === "tool_batch") {
    role = t("history.toolBatch");
    cls = "pbatch legacy-row";
  } else if (event.ch === "cont") {
    role = "continuation";
    cls = "system";
  } else {
    const key = EVENT_ROLE_KEYS[event.ch];
    role = key ? t(key) : event.ch;
    cls = "system";
  }
  const badge = event.changed === true ? t("history.changed") : event.changed === false ? t("history.unchanged") : "";
  const tokens = event.tok !== 0 ? `${event.tok > 0 ? "+" : "−"}${fmt(Math.abs(event.tok))} tok` : "";
  return (
    <div className={`loop-msg ${cls}`}>
      <span className={`loop-src ${event.omp ? "omp" : "rsa"}`}>{event.omp ? "OMP" : "RSA"}</span>
      <span className="loop-role">{role}{badge && <i>{badge}</i>}</span>
      <span className="loop-tok">{tokens} · {Math.round(event.t)}s</span>
    </div>
  );
}
