"use client";
import { useEffect, useRef, useState } from "react";
import type { CapabilityEntry, CapabilitiesResult } from "@/lib/capabilities";
import type { DiscoveredDriver } from "@/lib/drivers";
import { driverInitCommand } from "@/lib/driver-command";
import { useTranslations } from "@/lib/locale";

function useJson<T>(url: string | null): { value?: T; error?: string } {
  const t = useTranslations("capabilitiesView");
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? t("readFailed"));
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


function DiscoverDriver() {
  const t = useTranslations("capabilitiesView");
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
      if (!response.ok) throw new Error(value.error ?? t("readFailed"));
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
    catch { setCopied(""); setFailure(t("copyFailed")); }
  };
  return <section className="surface" aria-label={t("driverSectionLabel")}>
    <div className="surface-heading"><h2>{t("driverTitle")}</h2><span>{t("onDemandBadge")}</span></div>
    <div className="caps-section">
      <p className="bench-note">{t("discoverNote1a")}<code>github:org/repo#rev</code>{t("discoverNote1b")}<code>{t("examplePath")}</code>{t("discoverNote1c")}</p>
      <p className="bench-note">{t("discoverNote2a")}<code>load()</code>{t("discoverNote2b")}</p>
      <form className="caps-discover-row" onSubmit={event => { event.preventDefault(); void discover(); }}>
        <input value={spec} onChange={event => changeSpec(event.target.value)} placeholder={t("specPlaceholder")}
          aria-label={t("specAriaLabel")} spellCheck={false} />
        <button type="submit" className="control-button" disabled={pending || !spec.trim()}>
          {pending ? t("verifying") : t("verifyDriver")}
        </button>
      </form>
      {failure ? <p role="alert" className="bench-note error-text">{failure}</p> : null}
      {result ? <div className="caps-discover-result">
        <p className="bench-note">{t("verifiedPrefix")}<code>{result.spec}</code></p>
        <p><code>{result.id}</code> · {result.version}{result.transport ? ` · ${result.transport}` : ""}{result.defaultPort !== undefined ? `${t("defaultPortPrefix")}${result.defaultPort}` : ""}{result.needsGame ? t("needsGameNote") : ""}</p>
        {result.launchHint ? <p className="bench-note">{result.launchHint}</p> : null}
        <div className="bench-command">
          <code>{command}</code>
          <button type="button" className="control-button" onClick={copy}>{copied === command ? t("copiedLabel") : t("copyInitCommand")}</button>
        </div>
      </div> : null}
    </div>
  </section>;
}
function WorkspaceCapabilities({ project, ready, catalogError }: { project: string; ready: boolean; catalogError?: string }) {
  const t = useTranslations("capabilitiesView");
  const controlLabel = (item: CapabilityEntry) => item.requiresControl === null ? "—"
    : item.requiresControl ? t("needsControl") : t("noControl");
  const readOnlyLabel = (item: CapabilityEntry) => item.readOnly === null ? ""
    : item.readOnly ? t("readOnlySuffix") : t("sideEffectsSuffix");
  const capsLoad = useJson<CapabilitiesResult>(project ? `/api/capabilities?project=${encodeURIComponent(project)}` : null);
  const caps = capsLoad.value;
  const error = catalogError || capsLoad.error;
  if (error || !ready || (project && !caps)) return <section className="surface empty-state" aria-live="polite">
    <h2>{error ? t("loadErrorTitle") : t("loadingTitle")}</h2>
    <p>{error ?? t("loadingDesc")}</p>
  </section>;
  if (!caps?.project) return <section className="surface empty-state">
    <h2>{t("emptyTitle")}</h2><p>{t("emptyDesc")}</p>
  </section>;
  return <div className="caps-layout">
    {caps.issues.length > 0 && <details className="bench-warning"><summary>{t("diagnosticsTitle")}</summary>
      {caps.issues.map((issue, index) => <p key={index}>{issue.error}</p>)}
    </details>}
    <section className="metrics" aria-label={t("overviewLabel")}>
      {caps.groups.map(group => <div className="metric" key={group.id}>
        <span>{group.title}</span><strong>{group.items.length}</strong><small>{t("capabilitiesUnit")}</small>
      </div>)}
      <div className="metric"><span>{t("tasksMetricLabel")}</span><strong>{caps.tasks.length}</strong><small>{t("taskPackagesUnit")}</small></div>
    </section>
    {caps.groups.map(group => <section className="surface" key={group.id} aria-label={group.title}>
      <div className="surface-heading"><h2>{group.title}</h2><span>{group.items.length}{t("itemsUnit")}</span></div>
      {group.items.length ? <div className="bench-table-scroll"><table className="bench-table">
        <thead><tr><th>{t("capabilityCol")}</th><th>{t("descriptionCol")}</th><th>{t("controlCol")}</th></tr></thead>
        <tbody>{group.items.map(item => <tr key={item.id}>
          <td><code>{item.id}</code></td>
          <td>{item.description || <span className="muted">{t("noDescription")}</span>}</td>
          <td>{controlLabel(item)}{readOnlyLabel(item)}</td>
        </tr>)}</tbody>
      </table></div> : <p className="bench-note">{t("noGroupsHint")}</p>}
    </section>)}
    <section className="surface" aria-label={t("tasksSectionLabel")}>
      <div className="surface-heading"><h2>{t("benchmarkTitle")}</h2><span>{caps.tasks.length}{t("tasksUnit")}</span></div>
      {caps.tasks.length ? <div className="bench-table-scroll"><table className="bench-table">
        <thead><tr><th>{t("taskCol")}</th><th>{t("descriptionCol")}</th><th>{t("versionCol")}</th></tr></thead>
        <tbody>{caps.tasks.map(task => <tr key={`${task.name}@${task.digest}`}>
          <td><code>{task.name}</code></td>
          <td>{task.title !== task.name ? task.title : <span className="muted">{t("noDescription")}</span>}</td>
          <td><code>{task.digest.slice(0, 20)}…</code></td>
        </tr>)}</tbody>
      </table></div> : <p className="bench-note">{t("noTasksHint")}</p>}
    </section>
  </div>;
}

export function CapabilitiesView(props: { project: string; ready: boolean; catalogError?: string }) {
  return <div className="caps-layout">
    <WorkspaceCapabilities {...props} />
    <DiscoverDriver />
  </div>;
}
