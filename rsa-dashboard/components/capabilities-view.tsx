"use client";
import { useEffect, useState } from "react";
import type { CapabilityEntry, CapabilitiesResult } from "@/lib/capabilities";

function useJson<T>(url: string | null): { value?: T; error?: string } {
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "读取失败");
        if (!controller.signal.aborted) setLoaded({ url, value });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined, error: String(error) }));
      }
    };
    void load();
    return () => controller.abort();
  }, [url]);
  return loaded?.url === url ? loaded : {};
}

const controlLabel = (item: CapabilityEntry) => item.requiresControl === null ? "—"
  : item.requiresControl ? "需要接管" : "免接管";
const readOnlyLabel = (item: CapabilityEntry) => item.readOnly === null ? ""
  : item.readOnly ? " · 只读" : " · 有副作用";

export function CapabilitiesView({ project, ready, catalogError }: { project: string; ready: boolean; catalogError?: string }) {
  const capsLoad = useJson<CapabilitiesResult>(project ? `/api/capabilities?project=${encodeURIComponent(project)}` : null);
  const caps = capsLoad.value;
  const error = catalogError || capsLoad.error;
  if (error || !ready || (project && !caps)) return <section className="surface empty-state main-empty" aria-live="polite">
    <h2>{error ? "暂时无法读取能力" : "正在读取能力"}</h2>
    <p>{error ?? "从所选工作空间的 Baseware 目录与 Python 发现读取。"}</p>
  </section>;
  if (!caps?.project) return <section className="surface empty-state main-empty">
    <h2>还没有工作空间</h2><p>启动 RSA 并注册工作空间后，这里展示它的设备能力、自创能力与评测任务。</p>
  </section>;
  return <div className="caps-layout">
    {caps.issues.length > 0 && <details className="bench-warning"><summary>读取诊断</summary>
      {caps.issues.map((issue, index) => <p key={index}>{issue.error}</p>)}
    </details>}
    <section className="metrics" aria-label="能力概览">
      {caps.groups.map(group => <div className="metric" key={group.id}>
        <span>{group.title}</span><strong>{group.items.length}</strong><small>项能力</small>
      </div>)}
      <div className="metric"><span>评测任务</span><strong>{caps.tasks.length}</strong><small>个任务包</small></div>
    </section>
    {caps.groups.map(group => <section className="surface" key={group.id} aria-label={group.title}>
      <div className="surface-heading"><h2>{group.title}</h2><span>{group.items.length} 项</span></div>
      {group.items.length ? <div className="bench-table-scroll"><table className="bench-table">
        <thead><tr><th>能力</th><th>说明</th><th>控制要求</th></tr></thead>
        <tbody>{group.items.map(item => <tr key={item.id}>
          <td><code>{item.id}</code></td>
          <td>{item.description || <span className="muted">无描述</span>}</td>
          <td>{controlLabel(item)}{readOnlyLabel(item)}</td>
        </tr>)}</tbody>
      </table></div> : <p className="bench-note">暂无。设备能力来自连接时的实际目录；自创能力来自 workspace 的 @capability 发现。</p>}
    </section>)}
    <section className="surface" aria-label="评测任务">
      <div className="surface-heading"><h2>评测任务 · Benchmark</h2><span>{caps.tasks.length} 个</span></div>
      {caps.tasks.length ? <div className="bench-table-scroll"><table className="bench-table">
        <thead><tr><th>任务</th><th>版本摘要</th></tr></thead>
        <tbody>{caps.tasks.map(task => <tr key={`${task.name}@${task.digest}`}>
          <td><strong>{task.title}</strong><br /><small>{task.name}</small></td>
          <td><code>{task.digest.slice(0, 20)}…</code></td>
        </tr>)}</tbody>
      </table></div> : <p className="bench-note">目录中没有任务包。执行历史与评分见 Benchmark 的评测目录。</p>}
    </section>
  </div>;
}
