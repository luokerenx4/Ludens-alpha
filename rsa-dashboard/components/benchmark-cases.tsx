"use client";
import { useEffect, useState } from "react";
import {
  benchmarkCommand,
  benchmarkReportCommand,
  benchmarkSelection,
  displayCheckValue,
  reportLabel,
  benchmarkRunUrl,
  compareResults,
  definitionKey,
  resultKey,
  resultLabel,
  statusLabels,
  verdictLabels,
  type BenchmarkCatalog,
  type BenchmarkEvidence,
  type BenchmarkResult,
} from "@/lib/benchmarks";

const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const number = (value: number | null) =>
  value === null
    ? "—"
    : value !== 0 && Math.abs(value) < 0.01
      ? value.toExponential(3)
      : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const revision = (value: string) =>
  value.length > 16 ? value.slice(0, 12) : value;
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "读取失败");
  return body;
}
function Status({ result }: { result: BenchmarkResult }) {
  return (
    <>
      <span className={`bench-status ${result.status}`}>
        <i />
        {statusLabels[result.status]}
      </span>
      {!!result.report?.errors.length && (
        <span className="bench-status error">报告无效</span>
      )}
      {result.verdict && (
        <span className={`bench-status ${result.verdict}`}>
          <i />
          {verdictLabels[result.verdict]}
        </span>
      )}
    </>
  );
}

function useEvidence(
  record: BenchmarkResult | undefined,
  reportId: string | undefined,
) {
  const key = record ? `${resultKey(record)}@${reportId ?? ""}` : "";
  const [loaded, setLoaded] = useState<{
    key: string;
    proof?: BenchmarkEvidence;
    error?: string;
  } | null>(null);
  const project = record?.project,
    run = record?.runId,
    status = record?.status,
    endedAt = record?.endedAt;
  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ project, run });
    if (reportId) params.set("report", reportId);
    read<BenchmarkEvidence>("/api/benchmarks?" + params, controller.signal)
      .then((proof) => {
        if (!controller.signal.aborted) setLoaded({ key, proof });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoaded({ key, error: String(error) });
      });
    return () => controller.abort();
  }, [key, project, run, reportId, status, endedAt]);
  return loaded?.key === key ? loaded : null;
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
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [copyState, setCopyState] = useState("");
  const query = new URLSearchParams(search);
  const sourceFilter = query.get("benchSource") ?? "";
  const targetFilter = query.get("benchTarget") ?? "";
  const targets = [
    ...new Set(
      catalog?.benchmarks.flatMap((item) => item.definition.targets) ?? [],
    ),
  ].sort();
  const entries =
    catalog?.benchmarks.filter(
      (item) =>
        (!sourceFilter || item.definition.source === sourceFilter) &&
        (!targetFilter || item.definition.targets.includes(targetFilter)),
    ) ?? [];
  const selectedEntry =
    entries.find((item) => item.key === query.get("case")) ?? entries[0];
  const history =
    catalog?.results.filter(
      (result) =>
        definitionKey(result.definition, result.project) === selectedEntry?.key,
    ) ?? [];
  const selectedRun =
    history.find((result) => resultKey(result) === query.get("result")) ??
    history[0];
  const selectedKey = selectedRun ? resultKey(selectedRun) : "";
  const requestedReport = query.get("report") ?? selectedRun?.report?.id;
  const selectedLoad = useEvidence(selectedRun, requestedReport);
  const proof = selectedLoad?.proof;
  const selected = proof?.result;
  const candidates = history.filter(
    (result) =>
      (resultKey(result) !== selectedKey || result.reports.length > 1) &&
      result.status === "completed",
  );
  const baselineRun = candidates.find(
    (result) => resultKey(result) === query.get("baseline"),
  );
  const requestedBaselineReport =
    query.get("baselineReport") ?? baselineRun?.report?.id;
  const baselineLoad = useEvidence(baselineRun, requestedBaselineReport);
  const baseline = baselineLoad?.proof?.result;
  const comparison =
    selected && baseline ? compareResults(selected, baseline) : null;
  const definition = selectedRun?.definition ?? selectedEntry?.definition;
  const command = selectedEntry
    ? benchmarkCommand(selectedEntry)
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
  const runLink = (result: BenchmarkResult) =>
    benchmarkRunUrl(
      result,
      resultKey(result) === selectedKey ? proof?.epoch : undefined,
    );
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
  const selectResult = (result: BenchmarkResult) => {
    setOpenCheck(null);
    navigate(benchmarkSelection(result));
  };
  if (!catalog)
    return (
      <section className="surface empty-state main-empty" aria-live="polite">
        <h2>{error ? "暂时无法读取评测" : "正在读取评测"}</h2>
        <p>{error || "从各工作区的日志读取目录和结果。"}</p>
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
          <summary>{catalog.issues.length} 条目录或结果诊断</summary>
          {catalog.issues.map((issue, index) => (
            <p key={`${issue.project}/${issue.runId}/${index}`}>
              <code>
                {issue.project}
                {issue.runId ? ` / ${issue.runId}` : ""}
              </code>{" "}
              · {issue.error}
            </p>
          ))}
        </details>
      )}
      <div className="bench-selectors bench-filters">
        <label>
          来源
          <select
            aria-label="评测来源"
            value={sourceFilter}
            onChange={(event) =>
              navigate({
                benchSource: event.target.value || null,
                case: null,
                result: null,
                baseline: null,
                report: null,
                baselineReport: null,
              })
            }
          >
            <option value="">全部来源</option>
            <option value="builtin">RSA 内置</option>
            <option value="workspace">工作区</option>
          </select>
        </label>
        <label>
          关联能力
          <select
            aria-label="关联能力"
            value={targetFilter}
            onChange={(event) =>
              navigate({
                benchTarget: event.target.value || null,
                case: null,
                result: null,
                baseline: null,
                report: null,
                baselineReport: null,
              })
            }
          >
            <option value="">全部能力</option>
            {targets.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bench-case-layout">
        <aside className="surface bench-case-list" aria-label="评测目录">
          <div className="bench-list-heading">
            <span>{entries.length} 个评测</span>
            <small>所有工作空间</small>
          </div>
          {entries.map((item) => {
            const latest = catalog.results.find(
              (result) =>
                definitionKey(result.definition, result.project) === item.key,
            );
            return (
              <button
                key={item.key}
                className={
                  "bench-case-item" +
                  (selectedEntry?.key === item.key ? " selected" : "")
                }
                aria-pressed={selectedEntry?.key === item.key}
                onClick={() => {
                  setOpenCheck(null);
                  setCopyState("");
                  navigate({
                    case: item.key,
                    result: null,
                    baseline: null,
                    report: null,
                    baselineReport: null,
                  });
                }}
              >
                <div>
                  <strong>{item.definition.title}</strong>
                  <span className="bench-mode">
                    协议 {item.definition.protocolVersion}
                  </span>
                </div>
                <p>{item.definition.description}</p>
                <small>
                  {item.workspace ?? "RSA"}
                  {!item.available ? " · 历史定义" : ""}
                </small>
                <footer>
                  <span>{revision(item.definition.revision)}</span>
                  {latest ? (
                    <Status result={latest} />
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
                  <h2>{definition?.title ?? "暂无评测"}</h2>
                  {selected && <Status result={selected} />}
                </div>
                <p>{definition?.scope}</p>
              </div>
              {selectedEntry?.available && (
                <button className="control-button" onClick={copy}>
                  {copyState === "已复制" ? "✓ 已复制" : "复制运行命令"}
                </button>
              )}
            </header>
            {selectedEntry?.available ? (
              <div className="bench-command">
                <code>{command}</code>
                <span role="status">{copyState || "在终端显式执行"}</span>
              </div>
            ) : (
              <p className="bench-note">
                {selectedEntry
                  ? "当前目录中没有此定义，历史结果仍可查看。使用 rsa bench list 刷新工作区目录。"
                  : "没有符合筛选条件的评测。使用 rsa bench list 刷新工作区目录。"}
              </p>
            )}
            {!!definition?.targets.length && (
              <p className="bench-note">
                关联能力：{definition.targets.join("、")}
              </p>
            )}
            {selectedRun && (
              <>
                <div className="bench-selectors">
                  <label>
                    本次执行
                    <select
                      aria-label="评测执行记录"
                      value={selectedKey}
                      onChange={(event) => {
                        const result = history.find(
                          (item) => resultKey(item) === event.target.value,
                        );
                        if (result) selectResult(result);
                      }}
                    >
                      {history.map((result) => (
                        <option
                          key={resultKey(result)}
                          value={resultKey(result)}
                        >
                          {date(result.startedAt)} · {resultLabel(result)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    报告版本
                    <select
                      aria-label="报告版本"
                      value={requestedReport ?? ""}
                      onChange={(event) => {
                        setOpenCheck(null);
                        navigate({
                          result: selectedKey,
                          report: event.target.value || null,
                        });
                      }}
                    >
                      {!selectedRun.reports.length && (
                        <option value="">尚无报告</option>
                      )}
                      {requestedReport &&
                        !selectedRun.reports.some(
                          (report) => report.id === requestedReport,
                        ) && (
                          <option value={requestedReport}>
                            不可用 · {requestedReport}
                          </option>
                        )}
                      {[...selectedRun.reports].reverse().map((report) => (
                        <option key={report.id} value={report.id}>
                          {date(report.createdAt)} · {reportLabel(report)} ·{" "}
                          {report.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    比较基线
                    <select
                      aria-label="比较基线"
                      value={baselineRun ? resultKey(baselineRun) : ""}
                      onChange={(event) => {
                        const next = candidates.find(
                          (result) => resultKey(result) === event.target.value,
                        );
                        navigate({
                          result: selectedKey,
                          report: requestedReport ?? null,
                          baseline: next ? resultKey(next) : null,
                          baselineReport: next?.report?.id ?? null,
                        });
                      }}
                    >
                      <option value="">不比较</option>
                      {candidates.map((result) => (
                        <option
                          key={resultKey(result)}
                          value={resultKey(result)}
                        >
                          {date(result.startedAt)} · {resultLabel(result)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {baselineRun && (
                    <label>
                      基线报告
                      <select
                        aria-label="基线报告"
                        value={requestedBaselineReport ?? ""}
                        onChange={(event) =>
                          navigate({
                            result: selectedKey,
                            report: requestedReport ?? null,
                            baseline: resultKey(baselineRun),
                            baselineReport: event.target.value || null,
                          })
                        }
                      >
                        {!baselineRun.reports.length && (
                          <option value="">尚无报告</option>
                        )}
                        {requestedBaselineReport &&
                          !baselineRun.reports.some(
                            (report) => report.id === requestedBaselineReport,
                          ) && (
                            <option value={requestedBaselineReport}>
                              不可用 · {requestedBaselineReport}
                            </option>
                          )}
                        {[...baselineRun.reports].reverse().map((report) => (
                          <option key={report.id} value={report.id}>
                            {date(report.createdAt)} · {reportLabel(report)} ·{" "}
                            {report.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="bench-share">
                  <button
                    className="text-button"
                    disabled={
                      !selected?.report || (!!baselineRun && !baseline?.report)
                    }
                    title="固定本次与基线的报告版本"
                    onClick={async () => {
                      if (!selected?.report) return;
                      const pinned = benchmarkSelection(selected, baseline);
                      const params = new URLSearchParams({
                        view: "benchmark",
                        bench: "cases",
                      });
                      for (const [key, value] of Object.entries(pinned))
                        if (value) params.set(key, value);
                      try {
                        await navigator.clipboard.writeText(
                          new URL("/?" + params, window.location.href).href,
                        );
                        navigate(pinned);
                        setCopyState("已复制版本链接");
                      } catch {
                        setCopyState("复制失败，请复制浏览器地址");
                        navigate(pinned);
                      }
                    }}
                  >
                    复制固定版本链接
                  </button>
                  <small>报告修订不会增加执行次数。</small>
                </div>
              </>
            )}
            {!selectedRun ? (
              <div className="empty-state bench-never">
                <h3>尚未运行</h3>
                <p>执行后，结果会自动出现在这里。</p>
              </div>
            ) : !selected ? (
              <div
                className={selectedLoad?.error ? "error-banner" : "bench-note"}
                role="status"
              >
                <p>执行：{statusLabels[selectedRun.status]}</p>
                {selectedLoad?.error || "正在读取所选报告…"}
              </div>
            ) : (
              <>
                {query.get("result") && query.get("result") !== selectedKey && (
                  <p className="bench-warning">
                    所选记录已不可用，当前展示此评测的最近执行。
                  </p>
                )}
                {query.get("baseline") && !baselineRun && (
                  <p className="bench-warning">
                    该基线不可用，请选择同一评测的已完成记录。
                  </p>
                )}
                {baselineLoad?.error && (
                  <div className="error-banner" role="alert">
                    基线报告不可用：{baselineLoad.error}
                  </div>
                )}
                {baselineRun && !baselineLoad && (
                  <p className="bench-note">正在读取基线报告…</p>
                )}
                {baseline && !baseline.report?.outcome && (
                  <div className="bench-warning">
                    基线{reportLabel(baseline.report)}，无法据此形成比较结论。
                    {!!baseline.report?.errors.length && (
                      <ul>
                        {baseline.report.errors.map((issue, index) => (
                          <li key={index}>
                            <code>{issue.path}</code> · {issue.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {!!comparison?.changes.length && (
                  <p className="bench-warning">
                    比较条件不同：{comparison.changes.join("、")}
                    。差值仅供观察，不代表改动造成了变化。
                  </p>
                )}
                {comparison?.sameExecution && (
                  <p className="bench-warning">
                    这是同一次执行的报告修订对比，不是新增试验或能力改进。
                  </p>
                )}
                {comparison?.subjectsChanged && (
                  <p className="bench-note">
                    被测能力或模型版本已变化。下方版本记录保留本次与基线的对象信息。
                  </p>
                )}
                {selected.status === "running" && (
                  <p className="bench-note" role="status">
                    尚无结束记录。评测可能仍在执行或已中断，当前无法确认；检查与指标尚未定稿。
                  </p>
                )}

                {selected.error && (
                  <div className="error-banner" role="alert">
                    {selected.errorPhase && (
                      <strong>阶段：{selected.errorPhase} · </strong>
                    )}
                    {selected.error}
                  </div>
                )}
                <div className="bench-result-layers">
                  <div>
                    <span>执行</span>
                    <strong className={`bench-status ${selected.status}`}>
                      {statusLabels[selected.status]}
                    </strong>
                  </div>
                  <div>
                    <span>报告</span>
                    <strong
                      className={`bench-status ${selected.report?.errors.length ? "error" : ""}`}
                    >
                      {reportLabel(selected.report)}
                    </strong>
                    <small>{selected.report?.id ?? "未提交"}</small>
                  </div>
                  <div>
                    <span>结论</span>
                    <strong
                      className={`bench-status ${selected.verdict ?? ""}`}
                    >
                      {selected.verdict
                        ? verdictLabels[selected.verdict]
                        : "未形成结论"}
                    </strong>
                  </div>
                </div>
                {selected.report ? (
                  <section className="bench-report">
                    <p className="bench-note">
                      协议 {selected.report.protocolVersion} ·{" "}
                      {date(selected.report.createdAt)}
                      {selected.report.previousReportId
                        ? ` · 修订自 ${selected.report.previousReportId}`
                        : " · 首份报告"}
                    </p>
                    {selected.report.reason && (
                      <p className="bench-note">
                        修订说明：{selected.report.reason}
                      </p>
                    )}
                    {!!selected.report.errors.length && (
                      <div className="error-banner" role="alert">
                        <strong>报告未通过协议校验，无法据此形成结论。</strong>
                        <ul>
                          {selected.report.errors.map((issue, index) => (
                            <li key={index}>
                              <code>{issue.path}</code> · {issue.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {!selected.report.errors.length &&
                      !selected.checks.length &&
                      selected.status === "completed" && (
                        <p className="bench-note">
                          报告有效，未声明通过标准。指标作为测量记录保留。
                        </p>
                      )}
                    {(selected.status === "error" ||
                      selected.status === "cancelled") && (
                      <p className="bench-note">
                        执行异常或已取消；即使报告有效，也不形成通过结论。
                      </p>
                    )}
                    <details className="bench-report-raw">
                      <summary>原始报告</summary>
                      <pre>
                        {selected.report.rawText ??
                          JSON.stringify(selected.report.raw, null, 2)}
                      </pre>
                    </details>
                  </section>
                ) : (
                  <p className="bench-note">
                    本次执行尚未提交报告，不推断通过或失败。
                  </p>
                )}
                {(!selected.report || selected.report.errors.length > 0) && (
                  <div className="bench-command">
                    <code>{benchmarkReportCommand(selected)}</code>
                    <span>修正 report.json 后追加报告版本；保留本次执行。</span>
                  </div>
                )}
                <div className="bench-metrics">
                  {selected.metrics.length ? (
                    selected.metrics.map((metric) => {
                      const compared = comparison?.metrics.find(
                        (item) => item.id === metric.id,
                      );
                      const delta = compared?.delta ?? null;
                      const improved =
                        comparison?.compatible &&
                        !comparison.sameExecution &&
                        delta !== null &&
                        delta !== 0 &&
                        ((metric.direction === "lower" && delta < 0) ||
                          (metric.direction === "higher" && delta > 0));
                      return (
                        <div key={metric.id}>
                          <span>{metric.label ?? metric.id}</span>
                          <strong>
                            {number(metric.value)} <small>{metric.unit}</small>
                          </strong>
                          {metric.reason && <p>{metric.reason}</p>}
                          {baseline && (
                            <p>
                              基线 {number(compared?.baseline ?? null)}{" "}
                              <b className={improved ? "bench-improved" : ""}>
                                {delta === null
                                  ? "—"
                                  : `${delta > 0 ? "+" : ""}${number(delta)} ${metric.unit}`}
                              </b>
                              {compared && !compared.comparable && (
                                <small>
                                  指标缺失，或单位 / 方向不同，无法计算差值。
                                </small>
                              )}
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
                  {proof?.logAvailable ? (
                    <a
                      className="text-button"
                      href={runLink(selected)}
                      onClick={(event) => link(event, runLink(selected))}
                    >
                      查看评测运行 ↗
                    </a>
                  ) : (
                    <span className="muted">此执行未保存事件日志</span>
                  )}
                </div>
                {selected.parentRunId && (
                  <p className="bench-note">
                    <a
                      className="text-button"
                      href={
                        "/?" +
                        new URLSearchParams({
                          project: selected.project,
                          run: selected.parentRunId,
                          view: "live",
                        })
                      }
                      onClick={(event) =>
                        link(
                          event,
                          "/?" +
                            new URLSearchParams({
                              project: selected.project,
                              run: selected.parentRunId!,
                              view: "live",
                            }),
                        )
                      }
                    >
                      查看发起评测的运行 ↗
                    </a>
                  </p>
                )}
                {selected.checks.length ? (
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
                              <small>{displayCheckValue(check.expected)}</small>
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
                              <small>{displayCheckValue(check.actual)}</small>
                            </td>
                            <td>
                              {check.evidenceSeq.length ? (
                                <button
                                  className="text-button"
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
                ) : (
                  <p className="bench-note">
                    {selected.status === "running"
                      ? "等待检查完成"
                      : "本次没有检查项"}
                  </p>
                )}
                {openCheck && (
                  <section className="bench-evidence" aria-label="原始事件证据">
                    <h3>原始事件证据</h3>
                    {selectedLoad?.error ? (
                      <p className="error-text" role="alert">
                        {selectedLoad.error}
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
                      {selected.limitations.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!selected.artifacts?.length && (
                  <div className="bench-limitations">
                    <h3>评测产物</h3>
                    <ul>
                      {selected.artifacts.map((artifact, index) => (
                        <li key={`${artifact.path}/${index}`}>
                          {artifact.label && <span>{artifact.label} · </span>}
                          <code>{artifact.path}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <details className="bench-provenance">
                  <summary>
                    执行配置与版本{" "}
                    <span>
                      {revision(selected.definition.revision)} · 协议{" "}
                      {selected.definition.protocolVersion} ·{" "}
                      {number(selected.durationMs)} ms
                    </span>
                  </summary>
                  <dl className="fact-grid">
                    <div>
                      <dt>工作区</dt>
                      <dd>{selected.workspace}</dd>
                    </div>
                    <div>
                      <dt>评测运行</dt>
                      <dd>{selected.runId}</dd>
                    </div>
                  </dl>
                  <h3>本次执行</h3>
                  <pre>
                    {JSON.stringify(
                      {
                        definition: selected.definition,
                        parameters: selected.parameters,
                        conditions: selected.conditions ?? {},
                        subjects: selected.subjects ?? [],
                        reportId: selected.report?.id ?? null,
                        provenance: selected.provenance,
                        artifacts: selected.artifacts ?? [],
                        trace: selected.trace,
                      },
                      null,
                      2,
                    )}
                  </pre>
                  {baseline && (
                    <>
                      <h3>比较基线</h3>
                      <pre>
                        {JSON.stringify(
                          {
                            runId: baseline.runId,
                            reportId: baseline.report?.id ?? null,
                            definition: baseline.definition,
                            parameters: baseline.parameters,
                            conditions: baseline.conditions ?? {},
                            subjects: baseline.subjects ?? [],
                            provenance: baseline.provenance,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </>
                  )}
                </details>
              </>
            )}
          </section>
          <section className="surface bench-history">
            <div className="surface-heading">
              <h2>执行历史</h2>
              <span>{history.length} 次执行 · 每次显示最新报告</span>
            </div>
            {history.length ? (
              <div className="bench-table-scroll">
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>执行时间</th>
                      <th>执行 / 报告 / 结论</th>
                      <th>定义</th>
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
                            onClick={() => selectResult(result)}
                          >
                            {date(result.startedAt)}
                          </button>
                        </td>
                        <td>
                          <Status result={result} />
                        </td>
                        <td>
                          {revision(result.definition.revision)} · 协议{" "}
                          {result.definition.protocolVersion}
                          <small>
                            {result.definition.targets.join("、") ||
                              result.definition.id}
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
