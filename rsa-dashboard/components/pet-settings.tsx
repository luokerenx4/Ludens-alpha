"use client";

import { useEffect, useRef, useState } from "react";
import {
  useActivityPreferences,
  useDesktopCompanion,
  usePetSound,
} from "./pet-hooks";
import type { BlockKind } from "../lib/desktop";
import type { Project } from "../lib/types";
import { PetFollowSettings, type PetFollow } from "./pet-follow";
import "./pet-settings.css";

const blockLabels: Record<BlockKind, string> = {
  thinking: "思考",
  text: "文本",
  tool: "工具调用",
  system: "运行状态",
  diagnostic: "诊断详情",
};
function Switch({
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
  return (
    <label className="setting-row">
      <span className="setting-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
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
    <div className="pet-settings">
      <div className="pet-settings-intro">
        <div className="pet-monogram" aria-hidden="true">
          L
        </div>
        <div>
          <h2>Ludens Pet 陪伴</h2>
          <p>让正在发生的事，轻轻出现在桌面上。</p>
        </div>
        <span className="desktop-status">
          {bridge ? "桌面端已连接" : "浏览器模式"}
        </span>
      </div>
      <PetFollowSettings follow={follow} projects={projects} />
      {ready && !bridge && (
        <div className="desktop-only-note">
          <strong>关注工作区可在这里切换</strong>
          <p>
            浏览器与桌面端共享 Ludens Pet 的关注目标。下方的外观、通知和声音偏好，需要从
            Ludens Pet 托盘打开桌面窗口设置。
          </p>
        </div>
      )}
      <section className="setting-group">
        <header>
          <h3>桌面陪伴</h3>
          <p>浮窗继续使用 Ludens Pet 的外观、动作与音频。</p>
        </header>
        <Switch
          label="显示 Ludens Pet"
          hint="关闭主窗口后，Ludens Pet 和托盘仍会保留。"
          checked={visible ?? false}
          disabled={!bridge || visible === null || visibilityPending}
          onChange={() => void toggle()}
        />
        {visibilityError && (
          <p role="alert" className="setting-error">
            无法切换桌宠，请重试。
          </p>
        )}
      </section>
      <section className="setting-group">
        <header>
          <h3>日志与气泡</h3>
          <p>决定哪些内容展示在气泡中。完整日志始终留在运行视图。</p>
        </header>
        {prefs.loading && <p role="status">正在读取偏好…</p>}
        {(["enabled", "pet", "main", "brief"] as const).map((key) => (
          <Switch
            key={key}
            label={
              {
                enabled: "活动通知",
                pet: "Ludens Pet 气泡",
                main: "窗口内通知",
                brief: "简洁模式",
              }[key]
            }
            hint={
              key === "main"
                ? "Ludens Pet 隐藏时，在控制台内展示通知。"
                : key === "brief"
                  ? "隐藏日志正文，只显示活动状态。"
                  : undefined
            }
            checked={settings?.[key] ?? false}
            disabled={!settings || prefs.pending}
            onChange={(value) => {
              void prefs.update({ [key]: value });
            }}
          />
        ))}
        <div className="setting-subheading">展示内容</div>
        {(Object.keys(blockLabels) as BlockKind[]).map((kind) => (
          <Switch
            key={kind}
            label={blockLabels[kind]}
            checked={settings?.blocks[kind] ?? false}
            disabled={!settings || prefs.pending}
            onChange={(value) => {
              if (settings)
                void prefs.update({
                  blocks: { ...settings.blocks, [kind]: value },
                });
            }}
          />
        ))}
        <div className="setting-actions">
          <button
            className="control-button"
            disabled={!settings || prefs.pending}
            onClick={() => {
              void prefs.update({
                pausedUntil:
                  settings && settings.pausedUntil > now
                    ? 0
                    : Date.now() + 3_600_000,
              });
            }}
          >
            {settings && settings.pausedUntil > now ? "恢复通知" : "暂停一小时"}
          </button>
          <button
            className="control-button"
            disabled={!settings || prefs.pending}
            onClick={() => {
              void prefs.reset();
            }}
          >
            恢复通知默认值
          </button>
        </div>
        {!!settings && settings.pausedUntil > now && (
          <p role="status" className="setting-help">
            暂停至 {new Date(settings.pausedUntil).toLocaleTimeString()}
            ，不会暂停 Agent。
          </p>
        )}
        {prefs.error && (
          <p role="alert" className="setting-error">
            无法保存通知偏好，请重试。
          </p>
        )}
      </section>
      <section className="setting-group">
        <header>
          <h3>声音</h3>
          <p>保留原有的轻触提示音，也可以换成自己的声音。</p>
        </header>
        {sound.loading && <p role="status">正在读取声音设置…</p>}
        <Switch
          label="点击声音"
          checked={sound.settings?.enabled ?? false}
          disabled={!sound.settings || sound.pending}
          onChange={(enabled) => {
            void sound.update({ enabled });
          }}
        />
        <label className="setting-row">
          <span className="setting-label">音量</span>
          <span className="setting-volume">
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              disabled={!sound.settings || sound.pending}
              aria-label="音量"
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={(e) => {
                void sound.update({
                  volume: Number(e.currentTarget.value) / 100,
                });
              }}
              onKeyUp={(e) => {
                void sound.update({
                  volume: Number(e.currentTarget.value) / 100,
                });
              }}
            />
            <output>{volume}%</output>
          </span>
        </label>
        <div className="setting-audio">
          <span className="setting-label">声音文件</span>
          <p>{sound.settings?.source?.name ?? "桌面端加载后显示当前声音"}</p>
          <small>WAV、MP3 或 OGG，最多 2 MB、10 秒。文件保存在本机。</small>
          <input
            ref={file}
            type="file"
            accept=".wav,.mp3,.ogg"
            hidden
            aria-label="选择声音文件"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = "";
              if (chosen) void sound.importFile(chosen);
            }}
          />
          <div className="setting-actions">
            <button
              className="control-button"
              disabled={!bridge || sound.pending}
              onClick={() => file.current?.click()}
            >
              选择文件
            </button>
            <button
              className="control-button"
              disabled={
                !sound.settings?.source || sound.pending || volume === 0
              }
              onClick={() => {
                void sound.preview();
              }}
            >
              试听
            </button>
            <button
              className="control-button"
              disabled={!bridge || sound.pending}
              onClick={() => {
                void sound.reset();
              }}
            >
              恢复默认声音
            </button>
          </div>
        </div>
        {sound.pending && (
          <p role="status" className="setting-help">
            正在保存…
          </p>
        )}
        {sound.error && (
          <p role="alert" className="setting-error">
            {sound.error}
          </p>
        )}
      </section>
      <p className="setting-help">
        外观、通知与声音偏好保存在这台电脑的 Ludens Pet profile 中，不会修改工作区或 Agent 的行为。
      </p>
    </div>
  );
}
