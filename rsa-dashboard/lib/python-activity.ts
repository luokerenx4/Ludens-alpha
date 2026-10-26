import type { Event } from "./types";
import type { LogBlock } from "./activity";
import type { LogIndex } from "./log-index";

type Membership = { group: string; root: boolean };
type Summary = { calls: number; raised: number; pending: number; rootOutcome: string;
  lastException?: { seq: number; spanId: string; name: string; error: unknown } };

/** Only explicit Python parents form a group. Native bash does not supply a per-tool parent. */
export async function projectPythonCall(event: Event, blocks: Map<string, LogBlock>,
  members: Map<string, Membership>, index?: LogIndex) {
  if (!["python_call_start", "python_call_end"].includes(event.type)) return;
  const { trace, data } = event;
  if (!trace.traceId || !trace.spanId) return;
  const key = (span: string) => JSON.stringify([trace.epoch ?? "", trace.traceId, span]);
  const get = async (id: string) => members.get(id) ?? await index?.store("python-groups").get<Membership>(id);
  let member = await get(key(trace.spanId));
  if (event.type === "python_call_start") {
    const parent = trace.parentSpanId ? await get(key(trace.parentSpanId)) : undefined;
    member = { group: parent?.group ?? `python:${key(trace.spanId)}`, root: !parent };
    members.set(key(trace.spanId), member);
    await index?.store("python-groups").put(key(trace.spanId), member);
  }
  // An end without an observed start stays a raw diagnostic, not a fabricated group.
  if (!member) return;
  const previous = blocks.get(member.group) ?? await index?.store("blocks").get<LogBlock>(member.group);
  const summary: Summary = previous?.data ? { ...previous.data } as Summary
    : { calls: 0, raised: 0, pending: 0, rootOutcome: "pending" };
  if (event.type === "python_call_start") { summary.calls++; summary.pending++; }
  else {
    summary.pending = Math.max(0, summary.pending - 1);
    if (member.root) summary.rootOutcome = data.outcome ?? "unknown";
    if (data.outcome === "error") {
      summary.raised++;
      summary.lastException = { seq: event.seq, spanId: trace.spanId, name: String(data.id), error: data.error };
    }
  }
  const rootResult = summary.rootOutcome === "success" ? "外层函数已正常返回"
    : summary.rootOutcome === "error" ? "异常已传出外层函数"
    : summary.rootOutcome === "pending" ? "外层函数尚未结束" : `外层结果：${summary.rootOutcome}`;
  blocks.set(member.group, {
    id: member.group, kind: "diagnostic", at: previous?.at ?? event.at,
    title: previous?.title ?? `Python 调用 · ${data.id}`, source: previous?.source ?? event.source,
    trace: previous?.trace ?? trace, eventId: previous?.eventId ?? event.origin?.eventId,
    seq: previous?.seq ?? event.seq, updatedAt: event.at,
    status: summary.rootOutcome === "pending" ? "running" : "complete",
    ...(summary.raised ? { outcome: "raised" as const } : {}),
    text: `${summary.calls} 次函数调用，${summary.raised} 次抛出异常。${rootResult}。\n`
      + "函数异常不等于命令失败或测试失败；外层结果单独判断，是否预期需测试证据。原始事件可在诊断中按 Trace 查询。"
      + (summary.lastException ? `\n最近异常 #${summary.lastException.seq} · ${summary.lastException.name}\n${String(summary.lastException.error)}` : ""),
    data: summary,
  });
}
