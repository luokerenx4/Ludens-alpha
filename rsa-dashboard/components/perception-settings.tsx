"use client";

import { useCallback, useEffect, useState } from "react";
import type { Project } from "../lib/types";
import type { PerceptionSettings } from "../lib/perception-config";
import "./alice-settings.css";

const LIMITS = {
  hotSeconds: { min: 10, max: 3600, label: "热层加速窗口", help: "最近这段时长的原始帧留在内存里直接读取；调大更省解码，调小更省内存。超出部分始终可从磁盘录像读取。" },
  videoSegmentSeconds: { min: 10, max: 3600, label: "视频分段时长", help: "录像文件的切分粒度。段越长文件越少；不影响已录制内容的可读性。" },
  videoIdleSeconds: { min: 1, max: 600, label: "停采收尾延时", help: "停止采样后多久收尾当前视频段。收尾越快，最近录像越早定型。" },
} as const satisfies Record<keyof PerceptionSettings, { min: number; max: number; label: string; help: string }>;

function formatSeconds(value: number): string {
  if (value >= 60 && value % 60 === 0) return value % 3600 === 0 ? `${value / 3600} 小时` : `${value / 60} 分钟`;
  return `${value} 秒`;
}

/** Per-workspace perception tuning; writing takes effect after perception reload. */
export function PerceptionSettingsPanel({ project, projects }: { project: string; projects: Project[] }) {
  const [settings, setSettings] = useState<Partial<PerceptionSettings> | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/perception-config?project=${encodeURIComponent(project)}`,
        { cache: "no-store", signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "无法读取工作区设置");
      setSettings(value);
      setError("");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    }
  }, [project]);

  useEffect(() => {
    setSettings(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const target = projects.find((item) => item.id === project);
  if (!target?.workspace) return null;

  const update = async (patch: Partial<PerceptionSettings>) => {
    setPending(true);
    try {
      const response = await fetch(`/api/perception-config?project=${encodeURIComponent(project)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "保存失败");
      setSettings(value);
      setError("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  return <section className="setting-group perception-settings">
    <header>
      <h3>感知录制</h3>
      <p>当前工作区的录像与内存加速参数。修改在下次 <code>rsa perception reload</code> 后生效。</p>
    </header>
    {error && <p className="setting-error" role="alert">{error}</p>}
    {!settings ? <p className="setting-help">正在读取设置…</p> : (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => {
      const limit = LIMITS[key];
      const value = settings[key];
      const fallback = key === "hotSeconds" ? 600 : key === "videoSegmentSeconds" ? 300 : 10;
      const current = value ?? fallback;
      return <div key={key} className="perception-slider">
        <label htmlFor={`perception-${key}`}>
          <strong>{limit.label}</strong>
          <span className="perception-value">{formatSeconds(current)}{value === undefined ? "（默认）" : ""}</span>
        </label>
        <input
          id={`perception-${key}`}
          type="range"
          min={limit.min}
          max={limit.max}
          step={key === "videoIdleSeconds" ? 1 : 10}
          value={current}
          disabled={pending}
          aria-label={limit.label}
          onChange={(event) => {
            const next = Number(event.target.value);
            setSettings({ ...settings, [key]: next });
          }}
          onPointerUp={() => {
            if (settings[key] !== undefined) void update({ [key]: settings[key]! });
          }}
          onKeyUp={() => {
            if (settings[key] !== undefined) void update({ [key]: settings[key]! });
          }}
        />
        <small className="setting-help">{limit.help}</small>
        {value !== undefined && (
          <button type="button" className="control-button perception-reset"
            disabled={pending}
            onClick={() => void update({ [key]: undefined as never })}>
            恢复默认
          </button>
        )}
      </div>;
    })}
    {pending && <p className="setting-help" role="status">正在保存…</p>}
    {saved && <p className="setting-help" role="status">已保存。运行 `rsa perception reload` 后生效。</p>}
  </section>;
}
