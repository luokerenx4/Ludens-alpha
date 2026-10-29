"use client";
import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/locale";
import type { PerceptionRuntimeSnapshot } from "../lib/perception-config";
import { PERCEPTION_KEYS, type SavedPerception } from "./perception-draft";

export function PerceptionRuntimeStatus({ project, workspace, settings, revision, saving }: {
  project: string; workspace: string; settings: SavedPerception | null; revision: number; saving: boolean;
}) {
  const t = useTranslations("perceptionSettings");
  const [result, setResult] = useState<{ value: PerceptionRuntimeSnapshot; revision: number } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [project, workspace]);
  const check = async () => {
    if (request.current || saving) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/perception-config/runtime?" + new URLSearchParams({ project, workspace }),
        { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted && request.current === controller) { setResult({ value, revision }); setError(""); }
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setLoading(false); if (request.current === controller) request.current = null; }
  };
  const perception = result?.value.perception, values = perception?.values;
  const stale = !!result && (result.revision !== revision || !!error);
  const current = perception?.valueStatus === "current" && !stale;
  const overrides = PERCEPTION_KEYS.filter(key => settings?.[key] !== undefined);
  const matching = current && overrides.length > 0 && overrides.every(key => settings?.[key] === values?.[key]);
  const status = !result ? "runtimeUnchecked" : stale ? "runtimeStale"
    : result.value.connection === "unavailable" ? "runtimeUnavailable"
      : current ? !settings ? "runtimeSavedUnknown" : overrides.length ? matching ? "runtimeOverridesMatch" : "runtimeOverridesDiffer" : "runtimeObserved"
        : perception?.valueStatus === "last-loaded" ? "runtimeLastLoaded" : "runtimeNoValues";
  return <div className="space-y-4" data-perception-runtime>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-2"><h3 className="text-sm font-semibold">{t("runtimeTitle")}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground" role="status">{t(status)}</p>
        {perception && <Badge variant="outline">{t(`runtimeStates.${perception.state}`)}</Badge>}
      </div>
      <Button type="button" size="sm" variant="outline" aria-disabled={loading || saving} className="aria-disabled:opacity-50" onClick={() => void check()}>
        <Activity className="size-4" />{t(loading ? "checkingRuntime" : "checkRuntime")}
      </Button>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("runtimeReadOnly")}</p>
    {error && <Alert variant="destructive"><AlertDescription><p>{t("runtimeReadFailed")}</p>
      <details className="mt-2 text-xs"><summary>{t("errorDetails")}</summary><p className="mt-2 break-all">{error}</p></details>
    </AlertDescription></Alert>}
    {values && <dl className="grid gap-3 sm:grid-cols-3">{PERCEPTION_KEYS.map(key => <div key={key} className="rounded-md bg-background/40 p-3">
      <dt className="text-xs text-muted-foreground">{t(`limits.${key}.label`)}</dt><dd className="mt-1 text-sm tabular-nums">{values[key]} {t("seconds")}</dd>
    </div>)}</dl>}
    {result && <p className="text-xs text-muted-foreground">{t("checkedAt")} <time dateTime={result.value.checkedAt}>{new Date(result.value.checkedAt).toLocaleTimeString()}</time></p>}
    {perception?.error && <details className="text-xs text-muted-foreground"><summary>{t("errorDetails")}</summary><p className="mt-2 break-all">{perception.error}</p></details>}
  </div>;
}
