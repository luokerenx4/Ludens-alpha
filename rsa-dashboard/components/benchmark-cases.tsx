"use client";
import { useEffect, useState, type MouseEvent } from "react";
import {
  benchmarkCommand, benchmarkVerifyCommand, benchmarkSelection, benchmarkRunUrl, compareResults,
  evidenceLabel, parseResultKey, resultKey, statusLabels, taskKey, verificationLabel, verificationLabels,
  type BenchmarkAttachment, type BenchmarkCatalog, type BenchmarkEvidence, type BenchmarkEvidenceItem, type BenchmarkResult, type TrialSummary,
} from "@/lib/benchmarks";

const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const number = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const short = (value: string) => value.length > 24 ? value.slice(0, 20) + "…" : value;

/** Keep one page per request and discard late responses after navigation. */
function useBenchmarkRead<T>(url: string | null, refresh = false) {
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "读取失败");
        if (!controller.signal.aborted) setLoaded({ url, value });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined, error: String(error) }));
      } finally {
        if (refresh && !controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, refresh]);
  return loaded?.url === url ? loaded : null;
}
function detailUrl(key: string | null, verification?: string | null, cursors?: { verification?: string | null; evidence?: string | null }) {
  const identity = parseResultKey(key);
  if (!identity) return null;
  const params = new URLSearchParams(identity);
  if (verification) params.set("verification", verification);
  if (cursors?.verification) params.set("verificationCursor", cursors.verification);
  if (cursors?.evidence) params.set("evidenceCursor", cursors.evidence);
  return "/api/benchmarks?" + params;
}
function Status({ trial, result }: { trial: TrialSummary; result?: BenchmarkResult }) {
  return <>
    <span className={`bench-status ${trial.status}`}>{statusLabels[trial.status]}</span>
    {result && <span className={`bench-status ${result.verification?.status === "error" ? "error" : ""}`}>{verificationLabel(result.verification)}</span>}
  </>;
}
function EvidenceDetail({ item, result, onNavigate }: { item: BenchmarkEvidenceItem; result: BenchmarkResult; onNavigate: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ project: result.trial.project, run: result.trial.runId, attachment: String(item.index) });
  if (result.verification) params.set("verification", result.verification.id);
  const attachment = useBenchmarkRead<BenchmarkAttachment>(open && item.available && item.reference.kind === "file" ? "/api/benchmarks?" + params : null);
  const eventUrl = item.event ? benchmarkRunUrl(result.trial, item.event, item.reference) : null;
  return <details className="bench-evidence" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{evidenceLabel(item.reference)}{item.reference.reward && ` · ${item.reference.reward}`}{!item.available && " · 不可用"}</summary>
    {item.error && <p className="error-text" role="alert">{item.error}</p>}
    {eventUrl && <><a href={eventUrl} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onNavigate(eventUrl);
    }}>查看证据所在运行 ↗</a><pre>{JSON.stringify(item.event, null, 2)}</pre></>}
    {open && item.available && item.reference.kind === "file" && <>
      {!attachment && <p role="status">正在读取附件…</p>}
      {attachment?.error && <p className="error-text" role="alert">{attachment.error}</p>}
      {attachment?.value && <><pre>{attachment.value.text}</pre>{attachment.value.truncated && <p className="bench-note">仅展示前 256 KiB；原件保持完整。</p>}</>}
    </>}
    <pre>{JSON.stringify(item.reference, null, 2)}</pre>
  </details>;
}

export function BenchmarkCases({ search, refresh, navigate, onNavigate }: {
  search: string; refresh: boolean; navigate: (patch: Record<string, string | null>) => void; onNavigate: (url: string) => void;
}) {
  const query = new URLSearchParams(search);
  const [copied, setCopied] = useState("");
  const params = new URLSearchParams({ limit: "25" });
  if (query.get("benchWorkspace")) params.set("project", query.get("benchWorkspace")!);
  if (query.get("case")) params.set("task", query.get("case")!);
  if (query.get("benchCursor")) params.set("cursor", query.get("benchCursor")!);
  const catalogLoad = useBenchmarkRead<BenchmarkCatalog>("/api/benchmarks?" + params, refresh);
  const catalog = catalogLoad?.value;
  const rows = catalog?.history.trials ?? [];
  const selectedKey = query.get("result") ?? (rows[0] ? resultKey(rows[0]) : null);
  const selectedSummary = rows.find(row => resultKey(row) === selectedKey);
  const requestedVerification = query.get("verification") ?? query.get("report") ?? selectedSummary?.selectedVerificationId;
  const selectedLoad = useBenchmarkRead<BenchmarkEvidence>(detailUrl(selectedKey, requestedVerification, {
    verification: query.get("verificationCursor"), evidence: query.get("evidenceCursor"),
  }), refresh);
  const proof = selectedLoad?.value, selected = proof?.result;
  const baselineKey = query.get("baseline");
  const baselineLoad = useBenchmarkRead<BenchmarkEvidence>(detailUrl(baselineKey, query.get("baselineVerification") ?? query.get("baselineReport")));
  const baseline = baselineLoad?.value?.result;
  const comparison = selected && baseline ? compareResults(selected, baseline) : null;
  const workspace = catalog?.projects.find(item => item.id === catalog.project)?.workspace;
  const chosenName = query.get("case") ?? selected?.trial.task.name;
  const chosenDigest = query.get("caseDigest") ?? selected?.trial.task.digest;
  const chosenTask = catalog?.tasks.find(task => task.name === chosenName && (!chosenDigest || task.digest === chosenDigest));
  const reset = { result: null, baseline: null, verification: null, baselineVerification: null, report: null, baselineReport: null,
    verificationCursor: null, evidenceCursor: null, benchCursor: null, caseDigest: null };
  const link = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(url);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied("已复制"); }
    catch { setCopied("复制失败，请手动选择命令"); }
  };
  const selectTrial = (trial: TrialSummary) => navigate({ result: resultKey(trial), verification: trial.selectedVerificationId ?? null,
    report: null, verificationCursor: null, evidenceCursor: null });
  const rewards = selected?.verifier_result.rewards;
  const rewardKeys = comparison ? comparison.rewards.map(row => row.key) : Object.keys(rewards ?? {}).sort();

  if (!catalog) return <section className="surface empty-state main-empty" aria-live="polite">
    <h2>{catalogLoad?.error ? "暂时无法读取评测" : "正在读取评测"}</h2><p>{catalogLoad?.error ?? "读取任务目录和一页执行摘要。"}</p>
  </section>;
  return <div className="benchmark-cases">
    {catalogLoad.error && <div className="error-banner" role="alert">{catalogLoad.error}<small>保留上次读取的这一页</small></div>}
    {(catalog.issues.length > 0 || catalog.history.issues.length > 0) && <details className="bench-warning"><summary>目录或历史读取诊断</summary>
      {catalog.issues.map((issue, index) => <p key={`catalog:${index}`}><code>{issue.project}</code> · {issue.error}</p>)}
      {catalog.history.issues.map((issue, index) => <p key={`history:${index}`}><code>{issue.runId}</code> · {issue.error}</p>)}
    </details>}
    <div className="bench-toolbar"><label>工作区<select aria-label="评测工作区" value={catalog.project ?? ""}
      onChange={event => navigate({ ...reset, benchWorkspace: event.target.value || null, case: null })}>
      {!catalog.projects.length && <option value="">暂无工作区</option>}
      {catalog.projects.map(project => <option key={project.id} value={project.id}>{project.workspace}</option>)}
    </select></label><span className="muted">每页展示 25 次执行 · 浏览评测不影响 Agent 或 Ludens Pet 关注目标</span></div>
    <div className="bench-case-layout">
      <aside className="surface bench-case-list" aria-label="评测目录"><div className="bench-list-heading"><span>{catalog.tasks.length} 个任务包</span></div>
        <button className={`bench-case-item${!query.get("case") ? " selected" : ""}`} onClick={() => navigate({ ...reset, case: null })}>全部执行历史</button>
        {catalog.tasks.map(task => <button key={taskKey(task)} className={`bench-case-item${chosenTask === task ? " selected" : ""}`}
          aria-pressed={chosenTask === task} onClick={() => navigate({ ...reset, case: task.name, caseDigest: task.digest })}>
          <strong>{task.name}</strong>{task.title !== task.name && <p>{task.title}</p>}<small>{task.source === "repository" ? "仓库任务" : "工作区任务"} · {task.version ?? task.schemaVersion}</small>
          <footer><code>{short(task.digest)}</code>{task.unsupportedRequirements.length > 0 && <span className="bench-status error">环境要求未满足</span>}</footer>
        </button>)}
      </aside>
      <div className="bench-case-main">
        {chosenTask && <section className="surface bench-result">
          <header className="bench-result-heading"><div><h2>{chosenTask.name}</h2>{chosenTask.config.task.description && <p>{chosenTask.config.task.description}</p>}</div></header>
          {workspace && chosenTask.bindings.map(binding => {
            const command = benchmarkCommand(chosenTask, workspace, binding.path)!;
            return <div className="bench-command" key={binding.path}><code>{command}</code>
              <button className="control-button" onClick={() => void copy(command)}>复制运行命令</button></div>;
          })}
          {copied && <span role="status">{copied}</span>}
          {!chosenTask.bindings.length && <p className="bench-note">没有执行配置。在此任务来源的 benchmarks/runs 中添加 task 字段匹配的 JSON 配置，或在终端用 --config 选择配置。</p>}
          {chosenTask.unsupportedRequirements.length > 0 && <div className="bench-warning">当前环境不支持：{chosenTask.unsupportedRequirements.join("、")}</div>}
        </section>}
        <section className="surface bench-history"><div className="surface-heading"><h2>执行历史</h2><span>{rows.length} 次执行 · 评分修订不增加执行次数</span></div>
          {rows.length > 0 ? <div className="bench-table-scroll"><table className="bench-table"><thead><tr><th>执行时间 / 任务</th><th>执行状态</th><th>评分版本</th><th>操作</th></tr></thead><tbody>
            {rows.map(trial => <tr key={resultKey(trial)} className={resultKey(trial) === selectedKey ? "selected" : ""}>
              <td><button className="text-button" onClick={() => selectTrial(trial)}>{date(trial.startedAt)}</button><small>{trial.task.name}</small></td>
              <td><Status trial={trial} /></td><td><code>{trial.selectedVerificationId ?? "尚未评分"}</code></td>
              <td><button className="text-button" onClick={() => navigate({ baseline: resultKey(trial), baselineVerification: trial.selectedVerificationId ?? null, baselineReport: null })}>设为基线</button>
                <a className="text-button" href={benchmarkRunUrl(trial)} onClick={event => link(event, benchmarkRunUrl(trial))}>查看运行 ↗</a></td>
            </tr>)}
          </tbody></table></div> : <p className="bench-note">此页没有执行记录。历史任务即使已不在目录中，也可通过固定运行链接查看。</p>}
          <div className="bench-selectors">{query.get("benchCursor") && <button className="text-button" onClick={() => navigate({ benchCursor: null })}>最新一页</button>}
            {catalog.history.nextCursor && <button className="text-button" onClick={() => navigate({ benchCursor: catalog.history.nextCursor! })}>更早的 25 次执行 →</button>}</div>
        </section>
        <section className="surface bench-result" aria-label="执行与评分详情">
          {selectedLoad?.error && <div className="error-banner" role="alert">{selectedLoad.error}</div>}
          {selectedKey && !selected && !selectedLoad?.error && <p role="status">正在读取所选执行和评分…</p>}
          {!selectedKey && <p className="bench-note">选择一次执行查看评分与证据。</p>}
          {selected && <>
            <header className="bench-result-heading"><div><h2>{selected.trial.task.name}</h2><Status trial={selected.trial} result={selected} /></div>
              <button className="text-button" onClick={() => navigate(benchmarkSelection(selected, baseline))}>固定本次与基线版本</button></header>
            <p className="bench-note">{selected.trial.runId} · {date(selected.trial.startedAt)} · {number(selected.trial.durationMs)} ms</p>
            {selected.trial.status === "running" && <p className="bench-note" role="status">尚无执行结束记录；它可能仍在运行或已中断。</p>}
            {selected.trial.error && <div className="error-banner" role="alert">执行：{selected.trial.error.code} · {selected.trial.error.message}</div>}
            {selected.verification?.error && <div className="error-banner" role="alert">评分：{selected.verification.error.code} · {selected.verification.error.message}</div>}
            <div className="bench-result-layers"><div><span>执行</span><strong>{statusLabels[selected.trial.status]}</strong></div>
              <div><span>评分</span><strong>{verificationLabel(selected.verification)}</strong><small>{selected.verification?.id ?? "未提交"}</small></div>
              <div><span>任务版本</span><code>{short(selected.trial.task.digest)}</code></div></div>
            <section className="bench-report"><h3>评分版本</h3><p className="bench-note">重评仅读取已落盘产物，不重跑被测程序；得分为 0 属于正常测量值而非系统错误。</p>
              <div className="bench-verification-list">
                {proof!.verifications.verifications.map(verification => <div key={verification.id} className="bench-verification-row">
                  <button className="text-button" aria-pressed={selected.verification?.id === verification.id}
                    onClick={() => navigate({ verification: verification.id, report: null, evidenceCursor: null })}><code>{verification.id}</code></button>
                  <span className={`bench-status ${verification.status === "error" ? "error" : ""}`}>{verificationLabels[verification.status]}</span>
                  <small>{date(verification.startedAt)}{verification.reason ? ` · ${verification.reason}` : ""}</small>
                  <button className="text-button" onClick={() => navigate({ baseline: resultKey(selected.trial), baselineVerification: verification.id, baselineReport: null })}>设为基线</button>
                </div>)}
              </div>
              {!proof!.verifications.verifications.length && <p className="bench-note">尚无评分记录。</p>}
              <div className="bench-selectors">{query.get("verificationCursor") && <button className="text-button" onClick={() => navigate({ verificationCursor: null })}>最新评分页</button>}
                {proof!.verifications.nextCursor && <button className="text-button" onClick={() => navigate({ verificationCursor: proof!.verifications.nextCursor! })}>更早的评分 →</button>}</div>
              <div className="bench-command"><code>{benchmarkVerifyCommand(selected.trial)}</code><button className="text-button" onClick={() => void copy(benchmarkVerifyCommand(selected.trial))}>复制重评命令</button></div>
            </section>
            {baselineKey && <p className="bench-note">比较基线：<code>{baselineKey}</code>{baseline?.verification && ` @ ${baseline.verification.id}`} <button className="text-button" onClick={() => navigate({ baseline: null, baselineVerification: null, baselineReport: null })}>移除</button></p>}
            {baselineLoad?.error && <div className="error-banner" role="alert">基线读取失败：{baselineLoad.error}</div>}
            {baselineKey && !baseline && !baselineLoad?.error && <p role="status">正在读取基线…</p>}
            {!!comparison?.changes.length && <p className="bench-note">不同项：{comparison.changes.join("、")}。差值仅表示数值变化，请结合这些差异解读。</p>}
            {comparison?.sameExecution && <p className="bench-note">这是同一次执行的评分比较，不是两个独立试验。</p>}
            {comparison?.subjectsChanged && <p className="bench-note">被测代码或模型版本有变化；任务和条件差异仍独立检查。</p>}
            <h3>Reward</h3>
            {rewardKeys.length ? <div className="bench-table-scroll"><table className="bench-table"><thead><tr><th>维度</th><th>本次</th>{baseline && <><th>基线</th><th>差值</th></>}</tr></thead><tbody>
              {rewardKeys.map(key => { const compared = comparison?.rewards.find(row => row.key === key); return <tr key={key}><td>{key}</td><td>{number(rewards?.[key])}</td>
                {baseline && <><td>{number(compared?.baseline)}</td><td>{number(compared?.delta)}</td></>}</tr>; })}
            </tbody></table></div> : <p className="bench-note">{rewards === null || rewards === undefined ? "没有可用评分。" : "有效空 reward；它不构成任务成功结论。"}</p>}
            <div className="bench-checks-heading"><h3>评分证据与附件</h3><a className="text-button" href={benchmarkRunUrl(selected.trial)} onClick={event => link(event, benchmarkRunUrl(selected.trial))}>查看原始运行 ↗</a></div>
            {proof!.evidence.items.map(item => <EvidenceDetail key={`${selected.trial.id}:${selected.verification?.id}:${item.index}`} item={item} result={selected} onNavigate={onNavigate} />)}
            {!proof!.evidence.items.length && <p className="bench-note">未登记证据引用。</p>}
            <div className="bench-selectors">{query.get("evidenceCursor") && <button className="text-button" onClick={() => navigate({ evidenceCursor: null })}>第一页证据</button>}
              {proof!.evidence.nextCursor && <button className="text-button" onClick={() => navigate({ evidenceCursor: proof!.evidence.nextCursor! })}>更多证据 →</button>}</div>
            {selected.trial.parentRunId && <p><a href={benchmarkRunUrl({ project: selected.trial.project, runId: selected.trial.parentRunId })} onClick={event => link(event, benchmarkRunUrl({ project: selected.trial.project, runId: selected.trial.parentRunId! }))}>查看发起评测的运行 ↗</a></p>}
            {!!selected.trial.limitations?.length && <div className="bench-limitations"><h3>适用范围与限制</h3><ul>{selected.trial.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            <details className="bench-provenance"><summary>条件、被测版本与来源</summary><pre>{JSON.stringify({ task: selected.trial.task, parameters: selected.trial.parameters,
              conditions: selected.trial.conditions, subjects: selected.trial.subjects, trace: selected.trial.trace, legacy: selected.trial.legacy,
              verification: selected.verification }, null, 2)}</pre>{baseline && <><h3>基线</h3><pre>{JSON.stringify({ task: baseline.trial.task, parameters: baseline.trial.parameters,
                conditions: baseline.trial.conditions, subjects: baseline.trial.subjects, verification: baseline.verification }, null, 2)}</pre></>}</details>
          </>}
        </section>
      </div>
    </div>
  </div>;
}
