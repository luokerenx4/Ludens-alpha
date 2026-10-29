"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SeriesPoint } from "@/lib/loop-lab";
import { useTranslations } from "@/lib/locale";

const fmt = (n: number) => n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(Math.round(n));
const layers = [
  ["sys", "--loop-sys"], ["convo", "--loop-convo"], ["tools", "--loop-tools"],
  ["ptext", "--loop-ptext"], ["pimg", "--loop-pimg"],
] as const;

/** The exact request controls and numeric breakdown remain usable without the plot. */
export function LoopChart({ series, thresh, selected, onSelect }: {
  series: SeriesPoint[]; thresh: number; selected: number; onSelect(index: number): void;
}) {
  const t = useTranslations("loopLab"), id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = 240, pad = { l: 42, r: 12, t: 34, b: 26 };
  const right = Math.max(pad.l + 1, width - pad.r), bottom = height - pad.b;
  const peak = Math.max(1, ...series.map(point => point.total));
  const max = peak * 1.12;
  const x = (index: number) => pad.l + (series.length === 1 ? 0.5 : index / Math.max(1, series.length - 1)) * (right - pad.l);
  const y = (value: number) => bottom - value / max * (bottom - pad.t);
  const index = Math.min(series.length - 1, Math.max(0, selected - 1)), point = series[index];
  const tickIndices = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])].filter(value => value >= 0);
  const base = series.map(() => 0);
  const polygons = layers.map(([key, color]) => {
    const tops = series.map((item, i) => base[i] + item[key]);
    const points = series.length === 1
      ? `${pad.l},${y(tops[0])} ${right},${y(tops[0])} ${right},${y(base[0])} ${pad.l},${y(base[0])}`
      : [...tops.map((value, i) => `${x(i)},${y(value)}`), ...base.map((value, i) => `${x(i)},${y(value)}`).reverse()].join(" ");
    base.splice(0, base.length, ...tops);
    return { key, color, points };
  });
  const totalLine = series.length === 1 ? `${pad.l},${y(series[0].total)} ${right},${y(series[0].total)}`
    : series.map((item, i) => `${x(i)},${y(item.total)}`).join(" ");
  const bubbleWidth = 116, bubbleX = point ? Math.min(Math.max(x(index) - bubbleWidth / 2, pad.l), right - bubbleWidth) : 0;

  return <div ref={container} className="min-w-0" data-loop-chart>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-labelledby={`${id}-title ${id}-description`} className={series.length ? "block cursor-crosshair" : "block"}
      onClick={event => {
        if (!series.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const position = Math.min(1, Math.max(0, ((event.clientX - rect.left) * width / rect.width - pad.l) / (right - pad.l)));
        onSelect(Math.round(position * (series.length - 1)) + 1);
      }}>
      <title id={`${id}-title`}>{t("chart.title")}</title>
      <desc id={`${id}-description`}>{series.length ? `${series.length} ${t("chart.requests")}. ${t("chart.keyboardHint")}` : t("chart.empty")}</desc>
      {Array.from({ length: 5 }, (_, i) => max * i / 4).map(value => <g key={value}>
        <line x1={pad.l} x2={right} y1={y(value)} y2={y(value)} stroke="var(--border)" />
        <text x={pad.l - 7} y={y(value) + 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">{fmt(value)}</text>
      </g>)}
      {series.length > 0 ? <>
        {polygons.map(layer => <polygon key={layer.key} points={layer.points} fill={`var(${layer.color})`} opacity="0.8" />)}
        <polyline points={totalLine} fill="none" stroke="var(--loop-native)" strokeWidth="2" />
        {series.map((item, i) => item.compacted ? <line key={i} data-loop-compaction={item.request}
          x1={x(i)} x2={x(i)} y1={pad.t} y2={bottom} stroke="var(--loop-danger)" strokeDasharray="2 4">
          <title>{t("chart.compactedBefore")} #{item.request}</title>
        </line> : null)}
        {point && <g data-loop-selected-request={point.request}>
          <line x1={x(index)} x2={x(index)} y1={pad.t} y2={bottom} stroke="var(--primary)" strokeDasharray="4 3" />
          <circle cx={x(index)} cy={y(point.total)} r="4" fill="var(--primary)" stroke="var(--background)" strokeWidth="2" />
          <rect x={bubbleX} y="5" width={bubbleWidth} height="22" rx="5" fill="var(--popover)" stroke="var(--border)" />
          <text x={bubbleX + bubbleWidth / 2} y="20" textAnchor="middle" fontSize="11" fill="var(--foreground)">#{point.request} · {fmt(point.total)} tok</text>
        </g>}
        {tickIndices.map(i => <text key={i} x={x(i)} y={height - 7} textAnchor="middle" fill="var(--muted-foreground)" fontSize="11">{series[i].request}</text>)}
      </> : <text x={(pad.l + right) / 2} y={(pad.t + bottom) / 2} textAnchor="middle" fontSize="12" fill="var(--muted-foreground)">{t("chart.noRequests")}</text>}
    </svg>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("chart.threshold")}: {thresh.toLocaleString()} tok. {t("chart.thresholdContext")}</p>
  </div>;
}
