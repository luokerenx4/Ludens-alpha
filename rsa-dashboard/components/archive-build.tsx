"use client";

import { useEffect, useRef, useState } from "react";
import { readArchiveJson, type ArchiveBuildState } from "../lib/archive-client";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const stages: Record<string, string> = { queued: "stageQueued", snapshot: "stageSnapshot", events: "stageEvents",
  projections: "stageProjections", operations: "stageOperations", write: "stageWrite", ready: "stageReady" };
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + " MiB";

/** Observes build state without starting a build or tying its lifetime to this component. */
export function ArchiveBuild({ project, run, onReady }: { project: string; run: string; onReady(): void }) {
  const t = useTranslations("archiveBuild");
  const [state, setState] = useState<ArchiveBuildState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = project + "/" + run;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const current = useRef<ArchiveBuildState | null>(null);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    setState(null); setError(""); setBusy(false); current.current = null;
    if (!project || !run) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await readArchiveJson<ArchiveBuildState | null>("/api/run?" + new URLSearchParams({ project, run, build: "state" }), abort.signal);
        if (abort.signal.aborted) return;
        const previous = current.current;
        current.current = next; setState(next); setError("");
        if (next?.state === "ready" && previous && (previous.id !== next.id || previous.state !== "ready")) onReady();
      } catch (e) { if (!abort.signal.aborted) setError(String(e)); }
      finally {
        if (!abort.signal.aborted) timer = setTimeout(load,
          current.current?.state === "building" || current.current?.state === "queued" ? 1000 : 5000);
      }
    };
    void load();
    return () => { abort.abort(); mutation.current?.abort(); clearTimeout(timer); };
  }, [project, run, onReady]);

  async function control(action: "cancel" | "retry") {
    if (!state || busy) return;
    mutation.current?.abort();
    const abort = mutation.current = new AbortController();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, run, action, buildId: state.id }), signal: abort.signal });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? t("updateFailed"));
      if (!abort.signal.aborted && currentScope.current === scope) { current.current = next; setState(next); }
    } catch (e) { if (!abort.signal.aborted && currentScope.current === scope) setError(String(e)); }
    finally { if (!abort.signal.aborted && currentScope.current === scope) setBusy(false); }
  }

  if (!state || state.state === "ready") return error ? <Alert variant="destructive"><AlertDescription>{t("statusPrefix")}{error}</AlertDescription></Alert> : null;
  const working = state.state === "queued" || state.state === "building";
  const stageKey = stages[state.stage ?? ""];
  return <div className="archive-build" role="status">
    <div><strong>{working ? state.state === "queued" ? t("waitingTitle") : t("buildingTitle")
      : state.state === "cancelled" ? t("cancelledTitle") : t("failedTitle")}</strong>
      <p>{working ? `${stageKey ? t(stageKey) : t("stageFallback")}${state.totalBytes ? ` · ${mib(state.bytes ?? 0)} / ${mib(state.totalBytes)}` : ""}${state.eventPosition ? ` · ${state.eventPosition.toLocaleString()}${t("eventsSuffix")}` : ""}`
        : state.error ?? t("retryHint")}</p>
      {error && <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void control(working ? "cancel" : "retry")}>
      {busy ? t("processing") : working ? t("cancel") : t("retry")}
    </Button>
  </div>;
}
