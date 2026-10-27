"use client";

import { useEffect, useRef, useState } from "react";
import { readArchiveJson, type ArchiveBuildState } from "../lib/archive-client";

const stages: Record<string, string> = { queued: "等待整理", snapshot: "确定读取范围", events: "读取记录",
  projections: "整理统计与活动", operations: "整理动作记录", write: "写入目录", ready: "准备就绪" };
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + " MiB";

/** Observes build state without starting a build or tying its lifetime to this component. */
export function ArchiveBuild({ project, run, onReady }: { project: string; run: string; onReady(): void }) {
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
      if (!response.ok) throw new Error(next.error ?? "无法更新整理状态");
      if (!abort.signal.aborted && currentScope.current === scope) { current.current = next; setState(next); }
    } catch (e) { if (!abort.signal.aborted && currentScope.current === scope) setError(String(e)); }
    finally { if (!abort.signal.aborted && currentScope.current === scope) setBusy(false); }
  }

  if (!state || state.state === "ready") return error ? <p className="error-banner" role="alert">目录状态：{error}</p> : null;
  const working = state.state === "queued" || state.state === "building";
  return <div className="archive-build" role="status">
    <div><strong>{working ? state.state === "queued" ? "等待整理历史目录" : "正在整理历史目录"
      : state.state === "cancelled" ? "历史目录整理已取消" : "历史目录整理失败"}</strong>
      <p>{working ? `${stages[state.stage ?? ""] ?? "整理记录"}${state.totalBytes ? ` · ${mib(state.bytes ?? 0)} / ${mib(state.totalBytes)}` : ""}${state.eventPosition ? ` · ${state.eventPosition.toLocaleString()} 条事件` : ""}`
        : state.error ?? "可以重新整理，原始记录保持完整。"}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    <button type="button" className="text-button" disabled={busy} onClick={() => void control(working ? "cancel" : "retry")}>
      {busy ? "正在处理…" : working ? "取消整理" : "重新整理"}
    </button>
  </div>;
}
