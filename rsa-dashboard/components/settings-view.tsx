"use client";
import { PetSettings } from "@/components/pet-settings";
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";
import type { PetFollow } from "@/components/pet-follow";

/** 全局设置页：陪伴行为与控制台偏好；工作区运行信息在各自页面查看。 */
export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { locale, setLocale } = useLocale();
  const t = useTranslations("settings");
  return (
    <section className="settings-page mx-auto w-full max-w-7xl">
      <PetSettings follow={follow} projects={projects}>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>{t("language")}</CardTitle>
            <CardDescription>{t("languageDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <NativeSelect value={locale} onChange={event => setLocale(event.target.value === "zh" ? "zh" : "en")}
              aria-label={t("language")}>
              <NativeSelectOption value="en">{t("languageEnglish")}</NativeSelectOption>
              <NativeSelectOption value="zh">{t("languageChinese")}</NativeSelectOption>
            </NativeSelect>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>{t("consoleTitle")}</CardTitle>
            <CardDescription>
              {t("consoleDescription")}
            </CardDescription>
          </CardHeader>
        </Card>
      </PetSettings>
    </section>
  );
}
