"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  useActivityPreferences,
  useDesktopCompanion,
  usePetSound,
} from "./pet-hooks";
import type { BlockKind } from "../lib/desktop";
import type { Project } from "../lib/types";
import { PetFollowSettings, type PetFollow } from "./pet-follow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const blockLabels: Record<BlockKind, string> = {
  thinking: "思考",
  text: "文本",
  tool: "工具调用",
  system: "运行状态",
  diagnostic: "诊断详情",
};
function SettingSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange}
        aria-describedby={hint ? `${id}-hint` : undefined} />
    </div>
  );
}

export function PetSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { bridge, ready } = useDesktopCompanion();
  const sound = usePetSound(bridge),
    prefs = useActivityPreferences(bridge);
  const file = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState<boolean | null>(null);
  const [visibilityError, setVisibilityError] = useState(false);
  const [visibilityPending, setVisibilityPending] = useState(false);
  const [volume, setVolume] = useState(50);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (sound.settings) setVolume(Math.round(sound.settings.volume * 100));
  }, [sound.settings]);
  useEffect(() => {
    if (!bridge) return;
    let active = true,
      changed = false;
    const off = bridge.onVisibility((value) => {
      changed = true;
      if (active) setVisible(value);
    });
    void bridge
      .getVisible()
      .then((value) => {
        if (active && !changed) setVisible(value);
      })
      .catch(() => {
        if (active) setVisibilityError(true);
      });
    return () => {
      active = false;
      off();
    };
  }, [bridge]);
  const toggle = async () => {
    if (!bridge || visibilityPending) return;
    setVisibilityError(false);
    setVisibilityPending(true);
    try {
      setVisible(await bridge.toggle());
    } catch {
      setVisibilityError(true);
    } finally {
      setVisibilityPending(false);
    }
  };
  const settings = prefs.settings;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4 py-2">
        <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 font-serif text-3xl text-primary" aria-hidden="true">L</div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">卢登斯 · 桌面伴侣</h2>
          <p className="text-sm text-muted-foreground">让正在发生的事，轻轻出现在桌面上。</p>
        </div>
        <Badge variant="outline">{bridge ? "桌面端已连接" : "浏览器模式"}</Badge>
      </div>
      <PetFollowSettings follow={follow} projects={projects} />
      {ready && !bridge && (
        <Alert role="note">
          <AlertTitle>关注工作区可在这里切换</AlertTitle>
          <AlertDescription>
            浏览器与桌面端共享 Ludens Pet 的关注目标。下方的外观、通知和声音偏好，需要从
            Ludens Pet 托盘打开桌面窗口设置。
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={3}>桌面陪伴</CardTitle>
          <CardDescription>浮窗继续使用 Ludens Pet 的外观、动作与音频。</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingSwitch
            label="显示 Ludens Pet"
            hint="关闭主窗口后，Ludens Pet 和托盘仍会保留。"
            checked={visible ?? false}
            disabled={!bridge || visible === null || visibilityPending}
            onChange={() => void toggle()}
          />
          {visibilityError && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>无法切换桌宠，请重试。</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={3}>日志与气泡</CardTitle>
          <CardDescription>决定哪些内容展示在气泡中。完整日志始终留在运行视图。</CardDescription>
        </CardHeader>
        <CardContent>
          {prefs.loading && <p role="status" className="text-sm text-muted-foreground">正在读取偏好…</p>}
          {(["enabled", "pet", "main", "brief"] as const).map((key) => (
            <SettingSwitch
              key={key}
              label={{ enabled: "活动通知", pet: "Ludens Pet 气泡", main: "窗口内通知", brief: "简洁模式" }[key]}
              hint={key === "main" ? "Ludens Pet 隐藏时，在控制台内展示通知。"
                : key === "brief" ? "隐藏日志正文，只显示活动状态。" : undefined}
              checked={settings?.[key] ?? false}
              disabled={!settings || prefs.pending}
              onChange={(value) => { void prefs.update({ [key]: value }); }}
            />
          ))}
          <h3 className="mt-6 mb-1 text-xs font-medium text-muted-foreground">展示内容</h3>
          {(Object.keys(blockLabels) as BlockKind[]).map((kind) => (
            <SettingSwitch
              key={kind}
              label={blockLabels[kind]}
              checked={settings?.blocks[kind] ?? false}
              disabled={!settings || prefs.pending}
              onChange={(value) => {
                if (settings) void prefs.update({ blocks: { ...settings.blocks, [kind]: value } });
              }}
            />
          ))}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="outline" disabled={!settings || prefs.pending}
              onClick={() => { void prefs.update({ pausedUntil: settings && settings.pausedUntil > now ? 0 : Date.now() + 3_600_000 }); }}>
              {settings && settings.pausedUntil > now ? "恢复通知" : "暂停一小时"}
            </Button>
            <Button variant="outline" disabled={!settings || prefs.pending} onClick={() => { void prefs.reset(); }}>
              恢复通知默认值
            </Button>
          </div>
          {!!settings && settings.pausedUntil > now && (
            <p role="status" className="mt-3 text-xs leading-relaxed text-muted-foreground">
              暂停至 {new Date(settings.pausedUntil).toLocaleTimeString()}，不会暂停 Agent。
            </p>
          )}
          {prefs.error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>无法保存通知偏好，请重试。</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={3}>声音</CardTitle>
          <CardDescription>保留原有的轻触提示音，也可以换成自己的声音。</CardDescription>
        </CardHeader>
        <CardContent>
          {sound.loading && <p role="status" className="text-sm text-muted-foreground">正在读取声音设置…</p>}
          <SettingSwitch label="点击声音" checked={sound.settings?.enabled ?? false}
            disabled={!sound.settings || sound.pending} onChange={(enabled) => { void sound.update({ enabled }); }} />
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4">
            <span id="pet-volume-label" className="text-sm font-medium">音量</span>
            <div className="flex w-full max-w-64 items-center gap-4">
              <Slider min={0} max={100} step={1} value={[volume]} disabled={!sound.settings || sound.pending}
                aria-labelledby="pet-volume-label" onValueChange={([value]) => setVolume(value)}
                onValueCommit={([value]) => { void sound.update({ volume: value / 100 }); }} />
              <output className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{volume}%</output>
            </div>
          </div>
          <div className="mt-5 space-y-2">
            <h3 className="text-sm font-medium">声音文件</h3>
            <p className="text-sm break-all text-muted-foreground">{sound.settings?.source?.name ?? "桌面端加载后显示当前声音"}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">WAV、MP3 或 OGG，最多 2 MB、10 秒。文件保存在本机。</p>
            <input ref={file} type="file" accept=".wav,.mp3,.ogg" hidden aria-label="选择声音文件"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                if (chosen) void sound.importFile(chosen);
              }} />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" disabled={!bridge || sound.pending} onClick={() => file.current?.click()}>选择文件</Button>
              <Button variant="outline" disabled={!sound.settings?.source || sound.pending || volume === 0}
                onClick={() => { void sound.preview(); }}>试听</Button>
              <Button variant="outline" disabled={!bridge || sound.pending} onClick={() => { void sound.reset(); }}>恢复默认声音</Button>
            </div>
          </div>
          {sound.pending && <p role="status" className="mt-3 text-xs text-muted-foreground">正在保存…</p>}
          {sound.error && <Alert variant="destructive" className="mt-3"><AlertDescription>{sound.error}</AlertDescription></Alert>}
        </CardContent>
      </Card>
      <p className="text-xs leading-relaxed text-muted-foreground">
        外观、通知与声音偏好保存在这台电脑的 Ludens Pet profile 中，不会修改工作区或 Agent 的行为。
      </p>
    </div>
  );
}
