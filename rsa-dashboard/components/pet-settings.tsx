"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { useTranslations } from "@/lib/locale";

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
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-border/70 py-2 last:border-b-0">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange}
        aria-describedby={hint ? `${id}-hint` : undefined} />
    </div>
  );
}

export function PetSettings({ follow, projects, children }: { follow: PetFollow; projects: Project[]; children?: ReactNode }) {
  const { bridge, ready } = useDesktopCompanion();
  const sound = usePetSound(bridge),
    prefs = useActivityPreferences(bridge);
  const t = useTranslations("petSettings");
  const blockLabels: Record<BlockKind, string> = {
    thinking: t("blockThinking"),
    text: t("blockText"),
    tool: t("blockTool"),
    system: t("blockSystem"),
    diagnostic: t("blockDiagnostic"),
  };
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
    <div className="settings-layout space-y-5">
      <div className="settings-identity flex flex-wrap items-center gap-4 rounded-xl border bg-card px-5 py-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 font-serif text-2xl text-primary" aria-hidden="true">L</div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Badge variant="outline">{bridge ? t("connectedBadge") : t("browserBadge")}</Badge>
      </div>
      <div className="settings-grid grid items-start gap-5 min-[1180px]:grid-cols-2">
        <div className="settings-column grid min-w-0 gap-5">
          <PetFollowSettings follow={follow} projects={projects} />
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>{t("logsTitle")}</CardTitle>
              <CardDescription>{t("logsDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {prefs.loading && <p role="status" className="text-sm text-muted-foreground">{t("loadingPrefs")}</p>}
              {(["enabled", "pet", "main", "brief"] as const).map((key) => (
                <SettingSwitch
                  key={key}
                  label={{ enabled: t("prefEnabled"), pet: t("prefPet"), main: t("prefMain"), brief: t("prefBrief") }[key]}
                  hint={key === "main" ? t("mainHint")
                    : key === "brief" ? t("briefHint") : undefined}
                  checked={settings?.[key] ?? false}
                  disabled={!settings || prefs.pending}
                  onChange={(value) => { void prefs.update({ [key]: value }); }}
                />
              ))}
              <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">{t("contentHeading")}</h3>
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
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={!settings || prefs.pending}
                  onClick={() => { void prefs.update({ pausedUntil: settings && settings.pausedUntil > now ? 0 : Date.now() + 3_600_000 }); }}>
                  {settings && settings.pausedUntil > now ? t("resumeNotifications") : t("pauseHour")}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={!settings || prefs.pending} onClick={() => { void prefs.reset(); }}>
                  {t("resetDefaults")}
                </Button>
              </div>
              {!!settings && settings.pausedUntil > now && (
                <p role="status" className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {t("pausedPrefix")}{new Date(settings.pausedUntil).toLocaleTimeString()}{t("pausedSuffix")}
                </p>
              )}
              {prefs.error && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription>{t("savePrefsFailed")}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="settings-column grid min-w-0 gap-5">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>{t("companionTitle")}</CardTitle>
              <CardDescription>{t("companionDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <SettingSwitch
                label={t("showPetLabel")}
                hint={t("showPetHint")}
                checked={visible ?? false}
                disabled={!bridge || visible === null || visibilityPending}
                onChange={() => void toggle()}
              />
              {visibilityError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription>{t("toggleFailed")}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>{t("soundTitle")}</CardTitle>
              <CardDescription>{t("soundDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {sound.loading && <p role="status" className="text-sm text-muted-foreground">{t("loadingSound")}</p>}
              <SettingSwitch label={t("clickSoundLabel")} checked={sound.settings?.enabled ?? false}
                disabled={!sound.settings || sound.pending} onChange={(enabled) => { void sound.update({ enabled }); }} />
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4">
                <span id="pet-volume-label" className="text-sm font-medium">{t("volumeLabel")}</span>
                <div className="flex w-full max-w-64 items-center gap-4">
                  <Slider min={0} max={100} step={1} value={[volume]} disabled={!sound.settings || sound.pending}
                    aria-labelledby="pet-volume-label" onValueChange={([value]) => setVolume(value)}
                    onValueCommit={([value]) => { void sound.update({ volume: value / 100 }); }} />
                  <output className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{volume}%</output>
                </div>
              </div>
              <div className="mt-5 space-y-2">
                <h3 className="text-sm font-medium">{t("soundFileHeading")}</h3>
                <p className="text-sm break-all text-muted-foreground">{sound.settings?.source?.name ?? t("soundSourcePlaceholder")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("soundFormatHint")}</p>
                <input ref={file} type="file" accept=".wav,.mp3,.ogg" hidden aria-label={t("selectFileAria")}
                  onChange={(e) => {
                    const chosen = e.target.files?.[0];
                    e.target.value = "";
                    if (chosen) void sound.importFile(chosen);
                  }} />
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button type="button" size="sm" variant="outline" disabled={!bridge || sound.pending} onClick={() => file.current?.click()}>{t("chooseFile")}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!sound.settings?.source || sound.pending || volume === 0}
                    onClick={() => { void sound.preview(); }}>{t("previewLabel")}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!bridge || sound.pending} onClick={() => { void sound.reset(); }}>{t("restoreDefaultSound")}</Button>
                </div>
              </div>
              {sound.pending && <p role="status" className="mt-3 text-xs text-muted-foreground">{t("savingLabel")}</p>}
              {sound.error && <Alert variant="destructive" className="mt-3"><AlertDescription>{sound.error}</AlertDescription></Alert>}
            </CardContent>
          </Card>
          {children}
        </div>
      </div>
      {ready && !bridge && (
        <Alert role="note">
          <AlertTitle>{t("followSwitchTitle")}</AlertTitle>
          <AlertDescription>{t("followSwitchDesc")}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("footerNote")}
      </p>
    </div>
  );
}
