"use client";

import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/types";
import type { PerceptionSettings, PerceptionSettingsPatch } from "../lib/perception-config";
import "./pet-settings.css";

const LIMITS = {
  hotSeconds: { min: 10, max: 3600, fallback: 600, label: "热层加速窗口", help: "最近这段时长的原始帧优先留在内存里；实际保留量也受字节预算限制。持久化时，已落盘的录像可用于冷读取。" },
  videoSegmentSeconds: { min: 10, max: 3600, fallback: 300, label: "视频分段时长", help: "录像文件的切分粒度。段越长文件越少；段内已落盘的片段可读取，最新片段仍需等待编码落盘。" },
  videoIdleSeconds: { min: 1, max: 600, fallback: 10, label: "停采收尾延时", help: "停止采样后多久收尾当前视频段。收尾越快，最近录像越早定型。" },
} as const;
const KEYS = Object.keys(LIMITS) as (keyof PerceptionSettings)[];

function formatSeconds(value: number): string {
  if (value >= 60 && value % 60 === 0) return value % 3600 === 0 ? `${value / 3600} 小时` : `${value / 60} 分钟`;
  return `${value} 秒`;
}

/** A new workspace gets its own draft and request lifetime. */
export function PerceptionSettingsPanel({ project, projects }: { project: string; projects: Project[] }) {
  const target = projects.find((item) => item.id === project);
  if (!target?.workspace) return <section className="surface empty-state">
    <h2>选择已登记的工作区</h2><p>工作区启动后，可在这里调整感知录制参数。</p>
  </section>;
  return <WorkspacePerceptionSettings key={`${target.id}:${target.workspace}`} project={target.id} />;
}

function WorkspacePerceptionSettings({ project }: { project: string }) {
  const [settings, setSettings] = useState<Partial<PerceptionSettings> | null>(null);
  const [draft, setDraft] = useState<PerceptionSettingsPatch>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const saving = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/perception-config?project=${encodeURIComponent(project)}`,
          { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "无法读取工作区设置");
        if (!controller.signal.aborted) setSettings(value);
      } catch (cause) {
        if (!controller.signal.aborted) setError(String((cause as Error).message ?? cause));
      }
    };
    void load();
    return () => { controller.abort(); saving.current?.abort(); };
  }, [project]);

  const change = (key: keyof PerceptionSettings, value: number | null) => {
    setDraft(previous => {
      const next = { ...previous };
      if ((value ?? undefined) === settings?.[key]) delete next[key];
      else next[key] = value;
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    if (saving.current) return;
    const controller = new AbortController();
    saving.current = controller;
    setPending(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetch(`/api/perception-config?project=${encodeURIComponent(project)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "保存失败");
      if (!controller.signal.aborted) {
        setSettings(value);
        setDraft({});
        setSaved(true);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(`保存失败，修改尚未保存：${String((cause as Error).message ?? cause)}`);
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (saving.current === controller) saving.current = null;
    }
  };
  const changed = Object.keys(draft).length > 0;

  return <section className="setting-group perception-settings">
    <header>
      <h3>感知录制</h3>
      <p>保存当前工作区的参数后，运行 <code>rsa perception reload</code> 生效。未覆盖的参数继承感知进程的环境变量，否则使用内置默认值。</p>
    </header>
    {error && <p className="setting-error" role="alert">{error}</p>}
    {!settings ? !error && <p className="setting-help" role="status">正在读取设置…</p> : KEYS.map(key => {
      const limit = LIMITS[key];
      const value = Object.hasOwn(draft, key) ? draft[key] ?? undefined : settings[key];
      const current = value ?? limit.fallback;
      const custom = current < limit.min || current > limit.max || !Number.isInteger(current);
      return <div key={key} className="perception-slider">
        <label htmlFor={`perception-${key}`}>
          <strong>{limit.label}</strong>
          <span className="perception-value">{value === undefined ? "继承设置" : formatSeconds(value)}</span>
        </label>
        <input id={`perception-${key}`} type="range" min={limit.min} max={limit.max} step={1}
          value={Math.max(limit.min, Math.min(limit.max, Math.round(current)))} disabled={pending}
          aria-label={limit.label} aria-describedby={`perception-${key}-help`}
          onChange={event => change(key, Number(event.target.value))} />
        <small className="setting-help" id={`perception-${key}-help`}>
          {limit.help}{value === undefined && ` 内置默认：${formatSeconds(limit.fallback)}；当前未写入工作区覆盖。`}
          {custom && " 当前使用文件中的自定义值，只有调整滑条后才会覆盖。"}
        </small>
        {value !== undefined && <button type="button" className="control-button perception-reset"
          disabled={pending} onClick={() => change(key, null)}>恢复继承</button>}
      </div>;
    })}
    {settings && <button type="button" className="control-button" disabled={pending || !changed} onClick={() => void save()}>
      {pending ? "正在保存…" : "保存设置"}
    </button>}
    {changed && !pending && <p className="setting-help" role="status">有未保存的修改。</p>}
    {saved && <p className="setting-help" role="status">已保存。运行 <code>rsa perception reload</code> 后生效。</p>}
  </section>;
}
