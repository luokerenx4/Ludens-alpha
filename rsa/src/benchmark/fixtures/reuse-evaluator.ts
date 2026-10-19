import type { EventTrace } from "../../harness/events.ts";
import type { CaseOutcome } from "../types.ts";

export interface ReuseEvent {
  seq: number;
  type: string;
  source?: { component: string };
  trace: EventTrace;
  data: any;
}

const spanKey = (event: ReuseEvent) => event.trace.traceId && event.trace.spanId
  ? `${event.trace.traceId}:${event.trace.spanId}` : undefined;
const publicId = (origin: { path?: string; function?: string } | undefined) =>
  origin?.path && origin.function ? `python/${origin.path}:${origin.function}` : undefined;

/** Judge the environment's facts and causality; agent prose is never a verdict. */
export function evaluateReuse(all: ReuseEvent[], epoch: string): CaseOutcome {
  const events = all.filter(event => event.trace.epoch === epoch).sort((a, b) => a.seq - b.seq);
  const benchmark = (type: string) => events.filter(event => event.type === type && event.source?.component === "benchmark");
  const baseline = benchmark("benchmark_reuse_workspace")[0];
  const before = new Set<string>(baseline?.data.pythonFiles ?? []);
  const phases = benchmark("benchmark_reuse_phase");
  const phaseAt = (seq: number) => phases.filter(event => event.seq <= seq).at(-1)?.data.phase as number | undefined;
  const parents = new Map<string, string>();
  for (const event of events) {
    const key = spanKey(event);
    if (key && event.trace.parentSpanId) parents.set(key, `${event.trace.traceId}:${event.trace.parentSpanId}`);
  }
  const isDescendant = (event: ReuseEvent, ancestor: string) => {
    let current = spanKey(event);
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current); current = parents.get(current);
    }
    return false;
  };
  const successfulEnds = new Map(events.filter(event => event.type === "capability_end" && event.data.outcome === "success")
    .map(event => [spanKey(event), event]));
  const requests = events.filter(event => event.type === "capability_start");
  const discoveries = events.filter(event => event.type === "python_capabilities" && event.data.outcome === "success");
  const capabilitiesIn = (records: ReuseEvent[]) => records.flatMap(event => (event.data.capabilities ?? []).flatMap((capability: any) => {
    const id = publicId(capability.origin);
    return id && capability.codeSHA && !before.has(capability.origin.path) ? [{ event, capability, id }] : [];
  }));
  const discoveredCapabilities = capabilitiesIn(discoveries);
  const inventory = benchmark("benchmark_reuse_inventory").filter(event => event.data.stage === "post-run");
  const newCapabilities = [...discoveredCapabilities, ...capabilitiesIn(inventory)];
  const explicitlyDiscovered = discoveredCapabilities.filter(({ event, id }) => {
    const outer = requests.find(request => request.trace.traceId === event.trace.traceId
      && request.trace.spanId === event.trace.parentSpanId);
    const key = outer && spanKey(outer);
    return key && successfulEnds.has(key) && (outer!.data.action === "list"
      || (outer!.data.action === "help" && outer!.data.id === id));
  });
  const orders = benchmark("benchmark_reuse_order").flatMap(order => {
    const execution = events.find(event => event.type === "execution" && event.source?.component === "baseware"
      && event.data.id === order.data.executionId && event.data.outcome === "success"
      && event.data.status === "completed" && event.data.exitCode === 0);
    return execution ? [{ order, execution }] : [];
  });
  const validOrderIds = new Set(Array.from({ length: 6 }, (_, i) => `batch-${Math.floor(i / 3) + 1}-order-${i % 3 + 1}`));
  const completed = new Set(orders.map(({ order }) => order.data.orderId).filter(id => validOrderIds.has(id)));
  const calls = events.filter(event => event.type === "python_capability").flatMap(event => {
    const key = spanKey(event), id = publicId(event.data.origin);
    const outer = requests.find(request => spanKey(request) === key && request.data.action === "call" && request.data.id === id);
    const result = events.find(result => result.type === "python_capability_result" && spanKey(result) === key
      && result.data.outcome === "success" && result.data.codeSHA === event.data.codeSHA);
    if (!key || !id || !outer || !result || !successfulEnds.has(key) || !event.data.codeSHA) return [];
    const discovery = explicitlyDiscovered.find(item => item.id === id && item.event.seq < event.seq);
    if (!discovery) return [];
    const delivered = orders.filter(({ execution }) => isDescendant(execution, key));
    return delivered.length ? [{ event, id, key, discovery, orders: delivered }] : [];
  });
  const reused = new Map<string, typeof calls>();
  for (const id of new Set(calls.map(call => call.id))) {
    const candidates = calls.filter(call => call.id === id);
    const first = candidates.filter(call => phaseAt(call.event.seq) === 1 && call.orders.some(item => item.order.data.phase === 1));
    const second = candidates.filter(call => phaseAt(call.event.seq) === 2 && call.orders.some(item => item.order.data.phase === 2));
    if (first.some(a => second.some(b => a.key !== b.key && a.event.trace.modelCallId && b.event.trace.modelCallId
      && a.event.trace.modelCallId !== b.event.trace.modelCallId))) reused.set(id, candidates);
  }
  const reusedCalls = [...reused.values()].flat();
  const transferCalls = reusedCalls.filter(call => phaseAt(call.event.seq) === 2);
  const finish = benchmark("benchmark_reuse_finished").at(-1);
  const taskComplete = completed.size === 6 && finish?.data.completed === 6;
  const distinctNew = new Set(newCapabilities.map(item => item.id));
  const evidence = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  // On a negative result these references delimit the inspected run; they are
  // inspection scope, not positive evidence that discovery or reuse happened.
  const discoveryScope = evidence([...(baseline ? [baseline.seq] : []), ...discoveries.map(event => event.seq), ...(finish ? [finish.seq] : [])]);
  const reuseScope = evidence([...discoveryScope, ...phases.map(event => event.seq),
    ...requests.filter(event => event.data.action === "call" && event.data.id?.startsWith("python/")).map(event => event.seq)]);
  const models = events.filter(event => event.type === "model_start");
  const phaseOrders = (phase: number) => new Set(orders.filter(({ order }) => order.data.phase === phase).map(({ order }) => order.data.orderId)).size;
  const phaseRequests = (phase: number) => models.filter(event => phaseAt(event.seq) === phase).length;
  return {
    checks: [
      { id: "fresh-workspace", label: "干净 workspace 与新会话", passed: baseline ? before.size === 0 && baseline.data.experienceFiles === 0 && baseline.data.session === "new" : null,
        expected: "开始时无 Python 能力、skill 或 memory，创建新会话", actual: baseline ? `${before.size} 个 Python 文件，${baseline.data.experienceFiles} 个经验文件` : "缺少基线记录",
        evidenceSeq: baseline ? [baseline.seq] : [] },
      { id: "task-completed", label: "独立环境确认两批订单完成", passed: taskComplete,
        expected: "6 个不同订单被环境接受，并有成功设备调用", actual: `${completed.size}/6 个订单完成`,
        evidenceSeq: evidence([...orders.flatMap(item => [item.order.seq, item.execution.seq]), ...(finish ? [finish.seq] : [])]) },
      { id: "capability-created", label: "Agent 创建有效的装饰器能力", passed: distinctNew.size > 0,
        expected: "空白基线之后出现可被 AST 发现的 Python 装饰器能力", actual: `${distinctNew.size} 个新能力`,
        evidenceSeq: evidence(newCapabilities.map(item => item.event.seq)) },
      { id: "capability-discovered", label: "通过统一接口主动发现新能力", passed: explicitlyDiscovered.length > 0,
        expected: "Agent 调用 rsa controller / Client 的 list 或 help，成功发现新能力",
        actual: explicitlyDiscovered.length ? `${new Set(explicitlyDiscovered.map(item => item.id)).size} 个能力有显式发现证据`
          : "本轮目录查询至结束的检查范围内，未见主动发现新能力；引用为检查范围",
        evidenceSeq: explicitlyDiscovered.length ? evidence(explicitlyDiscovered.map(item => item.event.seq)) : discoveryScope },
      { id: "capability-reused", label: "经统一接口跨批复用能力", passed: reused.size > 0,
        expected: "通过 rsa controller / Client 调用同一注册 Python 能力，在两批、不同模型轮次中成功执行，且调用链完成订单",
        actual: reused.size ? `${reused.size} 个注册能力经统一接口跨批复用，第二批 ${transferCalls.length} 次有效调用`
          : "本轮统一接口调用记录中未见符合条件的跨批复用；引用为检查范围，不判断直接 import 的复用",
        evidenceSeq: reused.size ? evidence(reusedCalls.flatMap(call => [call.discovery.event.seq, call.event.seq,
          ...call.orders.flatMap(item => [item.order.seq, item.execution.seq])])) : reuseScope },
    ],
    metrics: [
      { id: "orders-completed", label: "完成订单", value: completed.size, unit: "orders", direction: "higher" },
      { id: "new-capabilities", label: "新能力（诊断）", value: distinctNew.size, unit: "capabilities", direction: "none" },
      { id: "productive-capability-calls", label: "跨批注册能力经统一接口有效调用", value: reusedCalls.length, unit: "calls", direction: "none" },
      { id: "productive-reuse-calls", label: "第二批经统一接口有效复用", value: transferCalls.length, unit: "calls", direction: "higher" },
      ...[1, 2].flatMap(phase => [
        { id: `phase-${phase}-requests`, label: `批次 ${phase} 模型请求`, value: phaseRequests(phase), unit: "requests", direction: "none" as const },
        { id: `phase-${phase}-orders`, label: `批次 ${phase} 完成订单`, value: phaseOrders(phase), unit: "orders", direction: "higher" as const },
        { id: `phase-${phase}-requests-per-order`, label: `批次 ${phase} 请求 / 完成订单`,
          value: phaseOrders(phase) ? phaseRequests(phase) / phaseOrders(phase) : null, unit: "requests/order", direction: "lower" as const },
      ]),
    ],
    limitations: [
      "同一新会话内的短时探索与迁移；没有证明跨会话长期学习或泛化。",
      "脚本数量不是成绩；空函数、失败调用和未推动订单的调用不算能力复用。",
      "结束后的评测侧 AST 盘点仅证明能力已创建，不代表 Agent 主动发现或通过统一接口复用。",
      "两批难度相近但不是严格对照实验，请求/订单变化仅作诊断。",
      "这是合作式 Agent 的功能评测，workspace 没有对恶意篡改日志做安全隔离。",
    ],
  };
}
