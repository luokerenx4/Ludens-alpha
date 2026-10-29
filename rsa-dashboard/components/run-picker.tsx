"use client";

import { ContextPicker, type ContextOption } from "@/components/context-picker";
import { useTranslations } from "@/lib/locale";
import { runIdentity } from "@/lib/run-identity";
import type { RunInfo } from "@/lib/types";

export function RunPicker({ runs, latest, value, onChange }: {
  runs: RunInfo[];
  latest?: RunInfo;
  value: string;
  onChange(value: string): void;
}) {
  const t = useTranslations("runPicker");
  const dt = useTranslations("dashboard");
  const et = useTranslations("workspaceRunEmpty");
  const latestLabel = latest ? dt("latestRun") : et("noGameRuns");
  const latestIdentity = latest ? runIdentity(latest.id) : null;
  const options: ContextOption[] = runs.length ? [{ value: "", label: latestLabel,
    secondarySummary: latestIdentity?.summary ?? undefined, identity: latestIdentity?.id },
  ...runs.map(run => {
    const identity = runIdentity(run.id);
    return { value: run.id, label: identity.summary ?? identity.id, identity: identity.summary ? identity.id : undefined,
      badge: run.kind === "benchmark" ? t("benchmark") : undefined };
  })] : [];
  const selected = value ? runIdentity(value) : latestIdentity;
  const triggerText = value ? selected?.summary ?? value
    : latestIdentity ? `${latestLabel} · ${latestIdentity.summary ?? latestIdentity.id}` : latestLabel;
  const triggerLabel = value && runs.some(run => run.id === value && run.kind === "benchmark")
    ? `${triggerText}${dt("benchSuffix")}` : triggerText;
  return <ContextPicker kind="run" options={options} value={value} onChange={onChange} label={dt("runHistoryLabel")} hideLabel
    trigger={{ text: runs.length ? triggerLabel : t("empty"), title: selected?.id ?? t("empty"), hint: selected?.id ?? t("description") }}
    copy={{ title: dt("runHistoryLabel"), description: t("description"), close: t("close"), current: t("current"), empty: t("empty") }} />;
}
