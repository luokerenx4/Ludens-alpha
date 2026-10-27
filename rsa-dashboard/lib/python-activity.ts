import type { Event } from "./types";
import type { LogBlock } from "./activity";
import type { LogIndex } from "./log-index";

type Membership = { group: string; root: boolean };
export type PythonSummary = { calls: number; raised: number; pending: number; rootOutcome: string;
  lastException?: { seq: number; spanId: string; name: string; error?: unknown } };
export function advancePythonSummary(previous: PythonSummary | undefined, event: Event, root: boolean): PythonSummary {
  const summary = previous ? { ...previous } : { calls: 0, raised: 0, pending: 0, rootOutcome: "pending" };
  if (event.type === "python_call_start") { summary.calls++; summary.pending++; }
  else {
    summary.pending = Math.max(0, summary.pending - 1);
    if (root) summary.rootOutcome = event.data.outcome ?? "unknown";
    if (event.data.outcome === "error") {
      summary.raised++;
      summary.lastException = { seq: event.seq, spanId: event.trace.spanId, name: String(event.data.id), error: event.data.error };
    }
  }
  return summary;
}

/** Only explicit Python parents form a group. Native bash does not supply a per-tool parent. */
export async function projectPythonCall(event: Event, blocks: Map<string, LogBlock>,
  members: Map<string, Membership>, index?: LogIndex) {
  if (!["python_call_start", "python_call_end"].includes(event.type)) return;
  const { trace, data } = event;
  if (!trace.traceId || !trace.spanId) return;
  const key = (span: string) => JSON.stringify([trace.epoch ?? "", trace.traceId, span]);
  const get = async (id: string) => members.get(id) ?? index?.store("python-groups").meta(id) as Membership | undefined;
  let member = await get(key(trace.spanId));
  if (event.type === "python_call_start") {
    const parent = trace.parentSpanId ? await get(key(trace.parentSpanId)) : undefined;
    member = { group: parent?.group ?? `python:${key(trace.spanId)}`, root: !parent };
    members.set(key(trace.spanId), member);
    index?.store("python-groups").index(key(trace.spanId), member);
  }
  // An end without an observed start stays a raw diagnostic, not a fabricated group.
  if (!member) return;
  const saved = index?.store("blocks").meta(member.group);
  const root = saved?.recipe?.position ? await index?.readEvent(saved.recipe.position) : undefined;
  const previous = blocks.get(member.group) ?? (root && saved?.recipe?.summary
    ? pythonSummaryBlock(root, member.group, saved.recipe.summary, saved.updatedAt) : undefined);
  const summary = advancePythonSummary(previous?.data as PythonSummary | undefined, event, member.root);
  blocks.set(member.group, pythonSummaryBlock(previous ? { ...event, at: previous.at, seq: previous.seq!,
    data: { id: previous.title.replace(/^Python 调用 · /, "") }, source: previous.source, trace: previous.trace ?? trace,
    origin: { ...event.origin!, eventId: previous.eventId! } } : event, member.group, summary, event.at));
}

export function pythonSummaryBlock(event: Event, group: string, summary: PythonSummary, updatedAt = event.at): LogBlock {
  const rootResult = summary.rootOutcome === "success" ? "外层函数已正常返回"
    : summary.rootOutcome === "error" ? "异常已传出外层函数"
    : summary.rootOutcome === "pending" ? "外层函数尚未结束" : `外层结果：${summary.rootOutcome}`;
  return {
    id: group, kind: "diagnostic", at: event.at,
    title: `Python 调用 · ${event.data.id}`, source: event.source, trace: event.trace,
    eventId: event.origin?.eventId, seq: event.seq, updatedAt,
    status: summary.rootOutcome === "pending" ? "running" : "complete",
    ...(summary.raised ? { outcome: "raised" as const } : {}),
    text: `${summary.calls} 次函数调用，${summary.raised} 次抛出异常。${rootResult}。\n`
      + "函数异常不等于命令失败或测试失败；外层结果单独判断，是否预期需测试证据。原始事件可在诊断中按 Trace 查询。"
      + (summary.lastException ? `\n最近异常 #${summary.lastException.seq} · ${summary.lastException.name}\n${String(summary.lastException.error)}` : ""),
    data: summary,
  };
}
