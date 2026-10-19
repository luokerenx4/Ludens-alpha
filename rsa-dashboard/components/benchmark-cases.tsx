"use client";
import { useEffect, useState } from "react";
import {
  benchmarkRunUrl,
  compatibleBaseline,
  comparisonChanges,
  resultKey,
  statusLabels,
  type BenchmarkCatalog,
  type BenchmarkEvidence,
  type BenchmarkResult,
  type BenchmarkStatus,
} from "@/lib/benchmarks";

const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const number = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "读取失败");
  return body;
}
function Status({ value }: { value: BenchmarkStatus }) {
  return (
    <span className={`bench-status ${value}`}>
      <i />
      {statusLabels[value]}
    </span>
  );
}

export function BenchmarkCases({
  search,
  refresh,
  navigate,
  onNavigate,
}: {
  search: string;
  refresh: boolean;
  navigate: (patch: Record<string, string | null>) => void;
  onNavigate: (url: string) => void;
}) {
  const [catalog, setCatalog] = useState<BenchmarkCatalog | null>(null);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<{
    key: string;
    data: BenchmarkEvidence;
  } | null>(null);
  const [evidenceError, setEvidenceError] = useState("");
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [copyState, setCopyState] = useState("");
  const query = new URLSearchParams(search);
  const selectedCase =
    catalog?.cases.find((item) => item.id === query.get("case")) ??
    catalog?.cases[0];
  const history =
    catalog?.results.filter((result) => result.caseId === selectedCase?.id) ??
    [];
  const selected =
    history.find((result) => resultKey(result) === query.get("result")) ??
    history[0];
  const selectedKey = selected ? resultKey(selected) : "";
  const candidates = selected
    ? history.filter(
        (result) =>
          resultKey(result) !== selectedKey &&
          compatibleBaseline(selected, result),
      )
    : [];
  const baseline = candidates.find(
    (result) => resultKey(result) === query.get("baseline"),
  );
  const proof = evidence?.key === selectedKey ? evidence.data : null;
  const changes =
    selected && baseline ? comparisonChanges(selected, baseline) : [];
  const command = selectedCase
    ? `rsa bench run ${selectedCase.id}${selectedCase.mode === "live" ? " --live" : ""}`
    : "rsa bench list";

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await read<BenchmarkCatalog>(
          "/api/benchmarks",
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setCatalog(next);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(String(error));
      } finally {
        if (!controller.signal.aborted && refresh)
          timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const project = selected?.project,
    run = selected?.runId,
    endedAt = selected?.endedAt,
    status = selected?.status;
  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    setEvidenceError("");
    read<BenchmarkEvidence>(
      "/api/benchmarks?" + new URLSearchParams({ project, run }),
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setEvidence({ key: `${project}/${run}`, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setEvidenceError(String(error));
      });
    return () => controller.abort();
  }, [project, run, endedAt, status]);
  function runLink(result: BenchmarkResult) {
    return benchmarkRunUrl(
      result,
      resultKey(result) === selectedKey ? proof?.epoch : undefined,
    );
  }
  const link = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate(url);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("已复制");
    } catch {
      setCopyState("复制失败，请选择下方命令复制");
    }
  };
  if (!catalog)
    return (
      <section className="surface empty-state main-empty" aria-live="polite">
        <h2>{error ? "暂时无法读取基准用例" : "正在读取基准用例"}</h2>
        <p>{error || "从各工作区的日志读取结果。"}</p>
      </section>
    );
  return (
    <div className="benchmark-cases">
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <small>保留上次读取的结果</small>
        </div>
      )}
      {catalog.issues.length > 0 && (
        <details className="bench-warning">
          <summary>{catalog.issues.length} 条结果无法读取</summary>
          {catalog.issues.map((issue) => (
            <p key={`${issue.project}/${issue.runId}`}>
              <code>{issue.runId}</code> · {issue.error}
            </p>
          ))}
        </details>
      )}
      <div className="bench-case-layout">
        <aside className="surface bench-case-list" aria-label="基准用例">
          <div className="bench-list-heading">
            <span>{catalog.cases.length} 个核心场景</span>
            <small>所有工作空间</small>
          </div>
          {catalog.cases.map((item) => {
            const latest = catalog.results.find(
              (result) => result.caseId === item.id,
            );
            return (
              <button
                key={item.id}
                className={
                  "bench-case-item" +
                  (selectedCase?.id === item.id ? " selected" : "")
                }
                aria-pressed={selectedCase?.id === item.id}
                onClick={() => {
                  setOpenCheck(null);
                  setCopyState("");
                  navigate({ case: item.id, result: null, baseline: null });
                }}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span className={"bench-mode " + item.mode}>{item.mode}</span>
                </div>
                <p>{item.description}</p>
                <footer>
                  <span>v{item.version}</span>
                  {latest ? (
                    <Status value={latest.status} />
                  ) : (
                    <span className="muted">尚未运行</span>
                  )}
                </footer>
                {latest && (
                  <small className="bench-last-run">
                    {date(latest.startedAt)}
                  </small>
                )}
              </button>
            );
          })}
        </aside>
        <div className="bench-case-main">
          <section className="surface bench-result">
            <header className="bench-result-heading">
              <div>
                <div className="bench-title">
                  <h2>{selectedCase?.title}</h2>
                  {selected && <Status value={selected.status} />}
                </div>
                <p>{selectedCase?.scope}</p>
              </div>
              <button className="control-button" onClick={copy}>
                {copyState === "已复制" ? "✓ 已复制" : "复制运行命令"}
              </button>
            </header>
            <div className="bench-command">
              <code>{command}</code>
              <span role="status">
                {copyState ||
                  (selectedCase?.mode === "live"
                    ? "真实模型 · 需显式 --live"
                    : "离线 · 不请求模型")}
              </span>
            </div>
            {!selected ? (
              <div className="empty-state bench-never">
                <h3>尚未运行</h3>
                <p>在终端执行上方命令。结果会自动出现在这里。</p>
              </div>
            ) : (
              <>
                <div className="bench-selectors">
                  <label>
                    本次执行
                    <select
                      aria-label="基准执行记录"
                      value={selectedKey}
                      onChange={(event) => {
                        setOpenCheck(null);
                        navigate({
                          case: selected.caseId,
                          result: event.target.value,
                          baseline: null,
                        });
                      }}
                    >
                      {history.map((result) => (
                        <option
                          key={resultKey(result)}
                          value={resultKey(result)}
                        >
                          {date(result.startedAt)} ·{" "}
                          {statusLabels[result.status]} · v{result.caseVersion}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    比较基线
                    <select
                      aria-label="比较基线"
                      value={baseline ? resultKey(baseline) : ""}
                      onChange={(event) =>
                        navigate({
                          case: selected.caseId,
                          result: selectedKey,
                          baseline: event.target.value || null,
                        })
                      }
                    >
                      <option value="">不比较</option>
                      {candidates.map((result) => (
                        <option
                          key={resultKey(result)}
                          value={resultKey(result)}
                        >
                          {date(result.startedAt)} ·{" "}
                          {statusLabels[result.status]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {query.get("result") && query.get("result") !== selectedKey && (
                  <p className="bench-warning">
                    所选记录已不可用，当前展示本用例的最近执行。
                  </p>
                )}
                {query.get("baseline") && !baseline && (
                  <p className="bench-warning">
                    该基线不可用，仅可比较同一用例、版本和运行模式。
                  </p>
                )}
                {changes.length > 0 && (
                  <p className="bench-warning">
                    比较条件不同：{changes.join("、")}
                    。差值仅供观察，不代表改动造成了变化。
                  </p>
                )}
                {selected.status === "running" && (
                  <p className="bench-note" role="status">
                    此用例仍在执行，检查与指标尚未定稿。
                  </p>
                )}
                {selected.error && (
                  <div className="error-banner" role="alert">
                    {selected.error}
                  </div>
                )}
                <div className="bench-metrics">
                  {selected.metrics.length ? (
                    selected.metrics.map((metric) => {
                      const previous = baseline?.metrics.find(
                        (item) =>
                          item.id === metric.id && item.unit === metric.unit,
                      );
                      const delta =
                        previous?.value != null && metric.value !== null
                          ? metric.value - previous.value
                          : null;
                      const improved =
                        delta !== null &&
                        delta !== 0 &&
                        ((metric.direction === "lower" && delta < 0) ||
                          (metric.direction === "higher" && delta > 0));
                      return (
                        <div key={metric.id}>
                          <span>{metric.label}</span>
                          <strong>
                            {number(metric.value)} <small>{metric.unit}</small>
                          </strong>
                          {baseline && (
                            <p>
                              基线 {number(previous?.value ?? null)}{" "}
                              <b className={improved ? "bench-improved" : ""}>
                                {delta === null
                                  ? "—"
                                  : `${delta > 0 ? "+" : ""}${number(delta)} ${metric.unit}`}
                              </b>
                            </p>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="muted">
                      {selected.status === "running"
                        ? "等待指标产出"
                        : "没有记录指标"}
                    </p>
                  )}
                </div>
                <div className="bench-checks-heading">
                  <h3>检查结果</h3>
                  <a
                    className="text-button"
                    href={runLink(selected)}
                    onClick={(event) => link(event, runLink(selected))}
                  >
                    查看运行剖析 ↗
                  </a>
                </div>
                <div className="bench-table-scroll">
                  <table className="bench-table">
                    <thead>
                      <tr>
                        <th>检查项 / 预期</th>
                        <th>实际结果</th>
                        <th>证据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.checks.map((check) => (
                        <tr key={check.id}>
                          <td>
                            <strong>{check.label}</strong>
                            <small>{check.expected}</small>
                          </td>
                          <td>
                            <span
                              className={`bench-check-state ${check.passed === true ? "passed" : check.passed === false ? "failed" : "inconclusive"}`}
                            >
                              {check.passed === true
                                ? "✓ 通过"
                                : check.passed === false
                                  ? "× 未通过"
                                  : "— 证据不足"}
                            </span>
                            <small>{check.actual}</small>
                          </td>
                          <td>
                            {check.evidenceSeq.length ? (
                              <button
                                className="text-button bench-evidence-button"
                                aria-expanded={openCheck === check.id}
                                onClick={() =>
                                  setOpenCheck(
                                    openCheck === check.id ? null : check.id,
                                  )
                                }
                              >
                                #{check.evidenceSeq[0]}
                                {check.evidenceSeq.length > 1
                                  ? ` +${check.evidenceSeq.length - 1}`
                                  : ""}{" "}
                                {openCheck === check.id ? "↑" : "↓"}
                              </button>
                            ) : (
                              <span className="muted">未提供</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!selected.checks.length && (
                  <p className="bench-note">
                    {selected.status === "running"
                      ? "等待检查完成"
                      : "本次没有检查结果"}
                  </p>
                )}
                {openCheck && (
                  <section className="bench-evidence" aria-label="原始事件证据">
                    <h3>原始事件证据</h3>
                    {evidenceError ? (
                      <p className="error-text" role="alert">
                        {evidenceError}
                      </p>
                    ) : !proof ? (
                      <p className="muted">正在读取事件…</p>
                    ) : (
                      selected.checks
                        .find((check) => check.id === openCheck)
                        ?.evidenceSeq.map((seq) => {
                          const event = proof.events.find(
                            (event) => event.seq === seq,
                          );
                          if (!event)
                            return (
                              <p key={seq} className="error-text">
                                #{seq} · 未找到原始事件，无法核对该证据。
                              </p>
                            );
                          const epoch = proof.epochs.includes(event.trace.epoch)
                            ? event.trace.epoch
                            : undefined;
                          const url = benchmarkRunUrl(selected, epoch, event);
                          return (
                            <details key={seq}>
                              <summary>
                                <span>
                                  #{seq} · {event.type}
                                </span>
                                <small>
                                  {event.source?.component ?? "未标注来源"} ·{" "}
                                  {date(event.at)}
                                </small>
                              </summary>
                              <a
                                className="text-button"
                                href={url}
                                onClick={(click) => link(click, url)}
                              >
                                {epoch
                                  ? "进入此事件的运行周期"
                                  : "查看原始运行"}{" "}
                                ↗
                              </a>
                              <pre>{JSON.stringify(event, null, 2)}</pre>
                            </details>
                          );
                        })
                    )}
                  </section>
                )}
                {!!selected.limitations?.length && (
                  <div className="bench-limitations">
                    <h3>适用范围与限制</h3>
                    <ul>
                      {selected.limitations.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <details className="bench-provenance">
                  <summary>
                    执行配置与版本{" "}
                    <span>
                      v{selected.caseVersion} · {selected.mode} ·{" "}
                      {selected.provenance.code?.commit.slice(0, 7) ??
                        "无代码版本"}
                      {selected.provenance.code?.dirty ? " + 未提交改动" : ""}
                    </span>
                  </summary>
                  <dl className="fact-grid">
                    <div>
                      <dt>模型</dt>
                      <dd>{selected.parameters.model ?? "离线模拟"}</dd>
                    </div>
                    <div>
                      <dt>预算</dt>
                      <dd>
                        {selected.parameters.seconds}s /{" "}
                        {selected.parameters.maxRequests} 请求
                      </dd>
                    </div>
                    <div>
                      <dt>随机种子</dt>
                      <dd>{selected.parameters.seed}</dd>
                    </div>
                    <div>
                      <dt>用时</dt>
                      <dd>{number(selected.durationMs)} ms</dd>
                    </div>
                    <div>
                      <dt>Project</dt>
                      <dd>{selected.project}</dd>
                    </div>
                    <div>
                      <dt>Run</dt>
                      <dd>{selected.runId}</dd>
                    </div>
                  </dl>
                  <pre>{JSON.stringify(selected.provenance, null, 2)}</pre>
                </details>
              </>
            )}
          </section>
          <section className="surface bench-history">
            <div className="surface-heading">
              <h2>执行历史</h2>
              <span>{history.length} 次 · 同一用例</span>
            </div>
            {history.length ? (
              <div className="bench-table-scroll">
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>执行时间</th>
                      <th>状态</th>
                      <th>条件</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((result) => (
                      <tr
                        className={
                          resultKey(result) === selectedKey ? "selected" : ""
                        }
                        key={resultKey(result)}
                      >
                        <td>
                          <button
                            className="text-button"
                            onClick={() => {
                              setOpenCheck(null);
                              navigate({
                                case: result.caseId,
                                result: resultKey(result),
                                baseline: null,
                              });
                            }}
                          >
                            {date(result.startedAt)}
                          </button>
                        </td>
                        <td>
                          <Status value={result.status} />
                        </td>
                        <td>
                          v{result.caseVersion} · {result.mode}
                          <small>
                            {result.parameters.model ?? "模拟传输 / 驱动"} ·
                            seed {result.parameters.seed}
                          </small>
                        </td>
                        <td>
                          <a
                            className="text-button"
                            href={runLink(result)}
                            onClick={(event) => link(event, runLink(result))}
                          >
                            查看运行 ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="bench-note">执行后保留每次结果，不覆盖历史。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
