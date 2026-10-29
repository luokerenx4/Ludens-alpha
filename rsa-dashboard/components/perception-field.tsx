"use client";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { useTranslations } from "@/lib/locale";
import { parsePerceptionDraft, PERCEPTION_FIELDS, type PerceptionKey, type PerceptionFieldDraft } from "./perception-draft";

export function PerceptionField({ name, saved, draft, pending, onEdit }: {
  name: PerceptionKey; saved?: number; draft?: PerceptionFieldDraft; pending: boolean;
  onEdit(mode: PerceptionFieldDraft["mode"], raw: string): void;
}) {
  const t = useTranslations("perceptionSettings"), id = useId(), limit = PERCEPTION_FIELDS[name];
  const label = t(`limits.${name}.label`), mode = draft?.mode ?? (saved === undefined ? "inherit" : "override");
  const raw = draft?.raw ?? (saved === undefined ? "" : String(saved));
  const parsed = parsePerceptionDraft(name, { mode, raw });
  const invalid = !!draft && parsed === undefined;
  const custom = !draft && saved !== undefined && parsed === undefined;
  const conflict = !!draft && draft.base !== saved;
  return <Card data-perception-field={name} className="gap-0">
    <CardContent className="grid gap-5 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] min-[1000px]:gap-10">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{label}</h3>
          {draft && <Badge variant="outline">{t("draftBadge")}</Badge>}</div>
        <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">{t(`limits.${name}.help`)}</p>
      </div>
      <div className="min-w-0 space-y-3">
        <NativeSelect value={mode} aria-label={`${label} · ${t("sourceLabel")}`} aria-disabled={pending}
          wrapperClassName="w-full sm:w-64" className="w-full aria-disabled:opacity-50"
          onKeyDown={event => { if (pending && event.key !== "Tab") event.preventDefault(); }}
          onPointerDown={event => { if (pending) event.preventDefault(); }}
          onChange={event => { if (!pending) onEdit(event.target.value === "inherit" ? "inherit" : "override", raw || String(saved ?? limit.fallback)); }}>
          <NativeSelectOption value="override">{t("workspaceOverride")}</NativeSelectOption>
          <NativeSelectOption value="inherit">{t("inheritEnvironment")}</NativeSelectOption>
        </NativeSelect>
        {mode === "override" ? <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2"><Input id={`${id}-value`} aria-label={label} value={raw} inputMode="numeric" autoComplete="off"
              maxLength={100} readOnly={pending} aria-disabled={pending} aria-invalid={invalid} className="w-28 tabular-nums aria-disabled:opacity-50"
              aria-describedby={`${id}-help ${id}-range${invalid ? ` ${id}-error` : ""}${custom ? ` ${id}-custom` : ""}`}
              onChange={event => { if (!pending) onEdit("override", event.target.value); }} />
              <span className="text-xs text-muted-foreground">{t("seconds")}</span></div>
            <div className="flex flex-wrap gap-1.5" aria-label={t("presetsLabel")}>{limit.presets.map(value => <Button key={value} type="button" size="sm"
              variant={parsed === value ? "secondary" : "outline"} aria-pressed={parsed === value} aria-disabled={pending} className="h-8 px-2 text-xs aria-disabled:opacity-50"
              onClick={() => { if (!pending) onEdit("override", String(value)); }}>{value >= 60 && value % 60 === 0 ? `${value / 60} ${t("presetMinutes")}` : `${value} ${t("presetSeconds")}`}</Button>)}</div>
          </div>
          {typeof parsed === "number" && <Slider min={limit.min} max={limit.max} step={1} value={[parsed]} aria-disabled={pending}
            className="aria-disabled:opacity-50" aria-label={`${label} · ${t("sliderLabel")}`} aria-describedby={`${id}-range`}
            onKeyDownCapture={event => { if (pending && event.key !== "Tab") event.preventDefault(); }}
            onPointerDownCapture={event => { if (pending) event.preventDefault(); }}
            onValueChange={([value]) => { if (!pending) onEdit("override", String(value)); }} />}
          <p id={`${id}-range`} className="text-xs text-muted-foreground">{t("rangePrefix")} {limit.min}–{limit.max} {t("wholeSeconds")}</p>
          {invalid && <p id={`${id}-error`} className="text-xs text-destructive" role="alert">{t("invalidValue")}</p>}
          {custom && <p id={`${id}-custom`} className="rounded-md border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">{t("customPreserved")}</p>}
        </> : <div className="rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">{t("inheritEnvironment")}</p><p className="mt-1">{t("inheritExplanation")}</p>
          <p className="mt-1">{t("builtinDefaultLabel")} {limit.fallback} {t("seconds")}. {t("runtimeMayDiffer")}</p>
        </div>}
        {conflict && <p className="text-xs leading-relaxed text-warning" role="status">{t("savedValueChanged")}</p>}
      </div>
    </CardContent>
  </Card>;
}
