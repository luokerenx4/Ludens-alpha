"use client";
import { useId } from "react";
import { Monitor } from "lucide-react";
import { PetSettings } from "@/components/pet-settings";
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";
import type { PetFollow } from "@/components/pet-follow";

export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { locale, setLocale } = useLocale();
  const t = useTranslations("settings");
  const languageId = useId();
  return <section className="settings-page mx-auto grid w-full max-w-5xl gap-6">
    <Card>
      <CardHeader className="flex flex-row items-start gap-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Monitor aria-hidden="true" className="size-5" /></div>
        <div className="space-y-1.5"><CardTitle role="heading" aria-level={2}>{t("consoleTitle")}</CardTitle>
          <CardDescription>{t("consoleDescription")}</CardDescription></div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
          <div className="min-w-0 space-y-1"><Label htmlFor={languageId}>{t("language")}</Label>
            <p id={`${languageId}-hint`} className="text-xs text-muted-foreground">{t("languageDescription")}</p></div>
          <NativeSelect id={languageId} value={locale} onChange={event => setLocale(event.target.value === "zh" ? "zh" : "en")}
            aria-describedby={`${languageId}-hint`} wrapperClassName="w-full min-[480px]:w-48" className="w-full">
            <NativeSelectOption value="en">{t("languageEnglish")}</NativeSelectOption>
            <NativeSelectOption value="zh">{t("languageChinese")}</NativeSelectOption>
          </NativeSelect>
        </div>
      </CardContent>
    </Card>
    <PetSettings follow={follow} projects={projects} />
  </section>;
}
