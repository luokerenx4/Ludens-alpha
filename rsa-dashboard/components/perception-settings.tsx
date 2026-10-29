"use client";

import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/types";
import type { PerceptionSettings, PerceptionSettingsPatch } from "../lib/perception-config";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";

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
  if (!target?.workspace) return <Card>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>选择已登记的工作区</CardTitle>
      <CardDescription>工作区启动后，可在这里调整感知录制参数。</CardDescription>
    </CardHeader>
  </Card>;
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

  return <Card className="max-w-4xl" aria-busy={pending}>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>感知录制</CardTitle>
      <CardDescription>
        保存当前工作区的参数后，运行 <code>rsa perception reload</code> 生效。未覆盖的参数继承感知进程的环境变量，否则使用内置默认值。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!settings ? !error && <p className="text-sm text-muted-foreground" role="status">正在读取设置…</p> : KEYS.map(key => {
        const limit = LIMITS[key];
        const value = Object.hasOwn(draft, key) ? draft[key] ?? undefined : settings[key];
        const current = value ?? limit.fallback;
        const custom = current < limit.min || current > limit.max || !Number.isInteger(current);
        return <div key={key} className="space-y-3 border-b border-border pb-5 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id={`perception-${key}-label`} className="text-sm font-medium">{limit.label}</h3>
            <Badge variant="secondary" className="tabular-nums">{value === undefined ? "继承设置" : formatSeconds(value)}</Badge>
          </div>
          <Slider min={limit.min} max={limit.max} step={1}
            value={[Math.max(limit.min, Math.min(limit.max, Math.round(current)))]} disabled={pending}
            aria-labelledby={`perception-${key}-label`} aria-describedby={`perception-${key}-help`}
            onValueChange={([value]) => change(key, value)} />
          <p className="text-xs leading-relaxed text-muted-foreground" id={`perception-${key}-help`}>
            {limit.help}{value === undefined && ` 内置默认：${formatSeconds(limit.fallback)}；当前未写入工作区覆盖。`}
            {custom && " 当前使用文件中的自定义值，只有调整滑条后才会覆盖。"}
          </p>
          {value !== undefined && <Button type="button" variant="outline" size="sm"
            disabled={pending} onClick={() => change(key, null)}>恢复继承</Button>}
        </div>;
      })}
      {settings && <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={pending || !changed} onClick={() => void save()}>
          {pending ? "正在保存…" : "保存设置"}
        </Button>
        {changed && !pending && <p className="text-xs text-muted-foreground" role="status">有未保存的修改。</p>}
      </div>}
      {saved && <p className="text-sm text-muted-foreground" role="status">已保存。运行 <code>rsa perception reload</code> 后生效。</p>}
    </CardContent>
  </Card>;
}
