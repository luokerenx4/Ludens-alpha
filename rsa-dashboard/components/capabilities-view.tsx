"use client";
import { useEffect, useRef, useState } from "react";
import type { CapabilityEntry, CapabilitiesResult } from "@/lib/capabilities";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverInitCommand } from "@/lib/driver-command";

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

function DiscoverDriver() {
  const [spec, setSpec] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiscoveredDriver | null>(null);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const changeSpec = (value: string) => {
    request.current?.abort();
    request.current = null;
    setSpec(value); setPending(false); setResult(null); setFailure(""); setCopied("");
  };
  const discover = async () => {
    if (request.current || !spec.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setFailure(""); setResult(null); setCopied("");
    try {
      const response = await fetch("/api/drivers/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: spec.trim() }), signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "读取失败");
      if (!controller.signal.aborted) setResult(value as DiscoveredDriver);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  };
  const command = result ? driverInitCommand(result) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(command); setFailure(""); }
    catch { setCopied(""); setFailure("无法复制，请手动选择并复制下方命令。"); }
  };
  return <section className="surface" aria-label="外部驱动">
    <div className="surface-heading"><h2>外部驱动验证 · Driver Package</h2><span>按需校验</span></div>
    <div className="caps-section">
      <p className="bench-note">输入外部驱动包地址（npm 包名、<code>github:org/repo#rev</code> 或 <code>file:/绝对路径</code>），校验其注册声明并生成工作区初始化命令。</p>
      <p className="bench-note">注意：验证过程可能下载安装依赖并会导入包代码，请仅使用可信来源。验证不调用 <code>load()</code>，通过仅代表声明合规，不保证设备可连接。</p>
      <form className="caps-discover-row" onSubmit={event => { event.preventDefault(); void discover(); }}>
        <input value={spec} onChange={event => changeSpec(event.target.value)} placeholder="github:org/repo#rev 或 npm 包名"
          aria-label="驱动包地址" spellCheck={false} />
        <button type="submit" className="control-button" disabled={pending || !spec.trim()}>
          {pending ? "验证中…" : "验证驱动包"}
        </button>
      </form>
      {failure ? <p role="alert" className="bench-note error-text">{failure}</p> : null}
      {result ? <div className="caps-discover-result">
        <p className="bench-note">已验证包：<code>{result.spec}</code></p>
        <p><code>{result.id}</code> · {result.version}{result.transport ? ` · ${result.transport}` : ""}{result.defaultPort !== undefined ? ` · 默认端口 ${result.defaultPort}` : ""}{result.needsGame ? " · 需传入游戏路径" : ""}</p>
        {result.launchHint ? <p className="bench-note">{result.launchHint}</p> : null}
        <div className="bench-command">
          <code>{command}</code>
          <button type="button" className="control-button" onClick={copy}>{copied === command ? "已复制" : "复制初始化命令"}</button>
        </div>
      </div> : null}
    </div>
  </section>;
}
function WorkspaceCapabilities({ project, ready, catalogError }: { project: string; ready: boolean; catalogError?: string }) {
  const capsLoad = useJson<CapabilitiesResult>(project ? `/api/capabilities?project=${encodeURIComponent(project)}` : null);
  const caps = capsLoad.value;
  const error = catalogError || capsLoad.error;
  if (error || !ready || (project && !caps)) return <section className="surface empty-state" aria-live="polite">
    <h2>{error ? "暂时无法读取能力" : "正在读取能力"}</h2>
    <p>{error ?? "正在从当前工作区的 baseware.json 与 Python @capability 声明读取…"}</p>
  </section>;
  if (!caps?.project) return <section className="surface empty-state">
    <h2>尚无已注册的工作区</h2><p>在工作区启动 RSA 后，这里将展示其设备能力快照、Python 自创能力与评测任务。</p>
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
        <thead><tr><th>任务</th><th>说明</th><th>版本摘要</th></tr></thead>
        <tbody>{caps.tasks.map(task => <tr key={`${task.name}@${task.digest}`}>
          <td><code>{task.name}</code></td>
          <td>{task.title !== task.name ? task.title : <span className="muted">无描述</span>}</td>
          <td><code>{task.digest.slice(0, 20)}…</code></td>
        </tr>)}</tbody>
      </table></div> : <p className="bench-note">目录中没有任务包。执行历史与评分见 Benchmark 的评测目录。</p>}
    </section>
  </div>;
}

export function CapabilitiesView(props: { project: string; ready: boolean; catalogError?: string }) {
  return <div className="caps-layout">
    <WorkspaceCapabilities {...props} />
    <DiscoverDriver />
  </div>;
}
