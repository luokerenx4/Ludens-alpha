"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useActivityPreferences, useDesktopCompanion, usePetSound, usePetVisibility } from "./pet-hooks";
import type { BlockKind, DesktopCompanion, PetSoundSettings } from "../lib/desktop";
import type { Project } from "../lib/types";
import type { DesktopFailure } from "./pet-resource";
import { PetFollowSettings, type PetFollow } from "./pet-follow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/locale";

function SettingSwitch({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void;
}) {
  const id = useId();
  return <div className="flex min-h-10 items-center justify-between gap-4 border-b border-border/70 py-2 last:border-b-0">
    <div className="min-w-0 space-y-1"><Label htmlFor={id}>{label}</Label>
      {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>
    <Switch id={id} checked={checked} aria-disabled={disabled} className="aria-disabled:opacity-50"
      onCheckedChange={value => { if (!disabled) onChange(value); }} aria-describedby={hint ? `${id}-hint` : undefined} />
  </div>;
}

type ReadState = { loading: boolean; pending: boolean; readError: string | null; retry(): void };
function ReadStatus({ resource, known, title }: { resource: ReadState; known: boolean; title: string }) {
  const t = useTranslations("petSettings");
  const label = t(resource.loading ? "readingSettings" : resource.readError ? "retryRead" : "readAgain");
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground" role="status">{resource.loading ? t("readingSettings") : known ? t("readValues") : t("unknownValues")}</p>
      <Button type="button" size="sm" variant="outline" aria-disabled={resource.loading || resource.pending} className="aria-disabled:opacity-50"
        aria-label={`${label} · ${title}`} onClick={() => { if (!resource.loading && !resource.pending) resource.retry(); }}>{label}</Button>
    </div>
    {resource.readError && <Alert variant="destructive"><AlertDescription>
      <p>{t("readFailed")}</p>{known && <p className="mt-1">{t("showingCached")}</p>}
      <details className="mt-2 text-xs"><summary className="cursor-pointer">{t("technicalDetails")}</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{resource.readError}</pre></details>
    </AlertDescription></Alert>}
  </div>;
}
function WriteStatus({ pending, error }: { pending: boolean; error: DesktopFailure | null }) {
  const t = useTranslations("petSettings");
  return <>{pending && <p role="status" className="mt-3 text-xs text-muted-foreground">{t("savingLabel")}</p>}
    {error && <Alert variant="destructive" className="mt-3"><AlertDescription>
      <p>{t(error.code === "invalidFile" ? "invalidSound" : "writeUnconfirmed")}</p>
      {error.code !== "invalidFile" && <details className="mt-2 text-xs"><summary className="cursor-pointer">{t("technicalDetails")}</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{error.detail}</pre></details>}
    </AlertDescription></Alert>}</>;
}

export function PetSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { bridge, ready, recheck } = useDesktopCompanion();
  const sound = usePetSound(bridge), prefs = useActivityPreferences(bridge), visibility = usePetVisibility(bridge);
  const t = useTranslations("petSettings");
  const titleId = useId(), volumeId = useId();
  const file = useRef<HTMLInputElement>(null), fileBridge = useRef<DesktopCompanion | null>(null);
  const [checkedAvailability, setCheckedAvailability] = useState(false);
  const [volumeDraft, setVolumeDraft] = useState<{ settings: PetSoundSettings; value: number } | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { fileBridge.current = null; setVolumeDraft(null) }, [bridge]);
  const settings = prefs.settings;
  const soundSettings = sound.settings;
  const volume = soundSettings ? volumeDraft?.settings === soundSettings ? volumeDraft.value : Math.round(soundSettings.volume * 100) : null;
  const blockLabels: Record<BlockKind, string> = { thinking: t("blockThinking"), text: t("blockText"), tool: t("blockTool"), system: t("blockSystem"), diagnostic: t("blockDiagnostic") };
  const prefsDisabled = prefs.pending || !!prefs.readError || !!prefs.writeError;
  const soundDisabled = sound.pending || !!sound.readError || (!!sound.writeError && sound.writeError.code !== "invalidFile");
  return <section aria-labelledby={titleId} className="grid min-w-0 gap-5 rounded-xl border bg-card p-5 max-[480px]:p-4">
    <header className="flex items-start gap-4">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 font-serif text-2xl text-primary" aria-hidden="true">L</div>
      <div className="min-w-0 space-y-1.5"><div className="flex flex-wrap items-center gap-2"><h2 id={titleId} className="text-base font-semibold">{t("title")}</h2><Badge variant="outline">{t("optionalBadge")}</Badge></div>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("subtitle")}</p></div>
    </header>
    <div className="grid min-w-0 items-start gap-4 min-[1000px]:grid-cols-2">
      <PetFollowSettings follow={follow} projects={projects} />
      <Card data-pet-availability>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle role="heading" aria-level={3}>{t("desktopPreferences")}</CardTitle>
          <Badge variant="outline">{t(!ready ? "checkingAvailability" : bridge ? "desktopWindowBadge" : "browserBadge")}</Badge>
        </div><CardDescription>{t(bridge ? "desktopAvailableHint" : "desktopUnavailableHint")}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" variant="outline" size="sm" onClick={() => { recheck(); setCheckedAvailability(true); }}>{t("checkAvailability")}</Button>
          <p className="text-xs leading-relaxed text-muted-foreground" role={checkedAvailability ? "status" : undefined}>{t(checkedAvailability ? bridge ? "checkedAvailable" : "checkedUnavailable" : "availabilityScope")}</p>
        </CardContent>
      </Card>
    </div>
    {bridge && <div className="grid min-w-0 items-start gap-4 min-[1100px]:grid-cols-2">
      <Card data-pet-resource="notifications" role="region" aria-label={t("logsTitle")}>
        <CardHeader><CardTitle role="heading" aria-level={3}>{t("logsTitle")}</CardTitle><CardDescription>{t("logsDesc")}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <ReadStatus resource={prefs} known={!!settings} title={t("logsTitle")} />
          {settings && <>
            <div>{(["enabled", "pet", "main", "brief"] as const).map(key => <SettingSwitch key={key}
              label={{ enabled: t("prefEnabled"), pet: t("prefPet"), main: t("prefMain"), brief: t("prefBrief") }[key]}
              hint={key === "main" ? t("mainHint") : key === "brief" ? t("briefHint") : undefined}
              checked={settings[key]} disabled={prefsDisabled} onChange={value => { void prefs.update({ [key]: value }) }} />)}</div>
            <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t("contentHeading")}</summary>
              <div className="mt-2">{(Object.keys(blockLabels) as BlockKind[]).map(kind => <SettingSwitch key={kind} label={blockLabels[kind]}
                checked={settings.blocks[kind]} disabled={prefsDisabled} onChange={value => { void prefs.update({ blocks: { ...settings.blocks, [kind]: value } }) }} />)}</div>
            </details>
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" aria-disabled={prefsDisabled} className="aria-disabled:opacity-50"
              onClick={() => { if (!prefsDisabled) void prefs.update({ pausedUntil: settings.pausedUntil > now ? 0 : Date.now() + 3_600_000 }) }}>{settings.pausedUntil > now ? t("resumeNotifications") : t("pauseHour")}</Button>
              <Button type="button" size="sm" variant="outline" aria-disabled={prefsDisabled} className="aria-disabled:opacity-50" onClick={() => { if (!prefsDisabled) void prefs.reset() }}>{t("resetDefaults")}</Button></div>
            {settings.pausedUntil > now && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{t("pausedPrefix")}{new Date(settings.pausedUntil).toLocaleTimeString()}{t("pausedSuffix")}</p>}
          </>}
          <WriteStatus pending={prefs.pending} error={prefs.writeError} />
        </CardContent>
      </Card>
      <div className="grid min-w-0 gap-4">
        <Card data-pet-resource="visibility" role="region" aria-label={t("companionTitle")}>
          <CardHeader><CardTitle role="heading" aria-level={3}>{t("companionTitle")}</CardTitle><CardDescription>{t("companionDesc")}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <ReadStatus resource={visibility} known={visibility.settings !== null} title={t("companionTitle")} />
            {visibility.settings !== null && <SettingSwitch label={t("showPetLabel")} hint={t("showPetHint")}
              checked={visibility.settings} disabled={visibility.pending || !!visibility.readError || !!visibility.writeError} onChange={() => { void visibility.toggle() }} />}
            <WriteStatus pending={visibility.pending} error={visibility.writeError} />
          </CardContent>
        </Card>
        <Card data-pet-resource="sound" role="region" aria-label={t("soundTitle")}>
          <CardHeader><CardTitle role="heading" aria-level={3}>{t("soundTitle")}</CardTitle><CardDescription>{t("soundDesc")}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <ReadStatus resource={sound} known={!!soundSettings} title={t("soundTitle")} />
            {soundSettings && volume !== null && <>
              <SettingSwitch label={t("clickSoundLabel")} checked={soundSettings.enabled} disabled={soundDisabled}
                onChange={enabled => { void sound.update({ enabled }) }} />
              <div className="space-y-3 border-b pb-4">
                <div className="flex items-center justify-between gap-4"><span id={volumeId} className="text-sm font-medium">{t("volumeLabel")}</span>
                  <output className="text-xs text-muted-foreground tabular-nums">{volume}%</output></div>
                <Slider min={0} max={100} step={1} value={[volume]} aria-disabled={soundDisabled} className="aria-disabled:opacity-50" aria-labelledby={volumeId}
                  onKeyDownCapture={event => { if (soundDisabled && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) event.preventDefault(); }}
                  onPointerDownCapture={event => { if (soundDisabled) event.preventDefault(); }}
                  onValueChange={([value]) => { if (!soundDisabled) setVolumeDraft({ settings: soundSettings, value }); }}
                  onValueCommit={([value]) => {
                    if (soundDisabled) return;
                    void sound.update({ volume: value / 100 }).then(() => {
                    if (sound.current()) setVolumeDraft(previous => previous?.settings === soundSettings ? null : previous);
                  }) }} />
              </div>
              <div className="space-y-2"><h3 className="text-sm font-medium">{t("soundFileHeading")}</h3>
                <p className="break-all text-sm text-muted-foreground">{soundSettings.source?.name ?? t("noSoundFile")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("soundFormatHint")}</p>
                <input ref={file} type="file" accept=".wav,.mp3,.ogg" hidden aria-label={t("selectFileAria")} onChange={event => {
                  const chosen = event.target.files?.[0]; event.target.value = "";
                  if (chosen && fileBridge.current === bridge && !soundDisabled) void sound.importFile(chosen);
                }} />
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button type="button" size="sm" variant="outline" aria-disabled={soundDisabled} className="aria-disabled:opacity-50" onClick={() => { if (soundDisabled) return; fileBridge.current = bridge; file.current?.click() }}>{t("chooseFile")}</Button>
                  <Button type="button" size="sm" variant="outline" aria-disabled={!soundSettings.source || soundDisabled || volume === 0} className="aria-disabled:opacity-50" onClick={() => { if (soundSettings.source && !soundDisabled && volume !== 0) void sound.preview() }}>{t("previewLabel")}</Button>
                  <Button type="button" size="sm" variant="outline" aria-disabled={soundDisabled} className="aria-disabled:opacity-50" onClick={() => { if (!soundDisabled) void sound.reset() }}>{t("restoreDefaultSound")}</Button>
                </div>
              </div>
            </>}
            <WriteStatus pending={sound.pending} error={sound.writeError} />
            {sound.previewError && <Alert variant="destructive"><AlertDescription>{t("previewFailed")}</AlertDescription></Alert>}
          </CardContent>
        </Card>
      </div>
    </div>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t("footerNote")}</p>
  </section>;
}
