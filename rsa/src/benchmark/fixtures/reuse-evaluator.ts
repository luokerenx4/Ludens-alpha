import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
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
interface PythonEvidence {
  functions?: string[];
  effectfulFunctions?: string[];
  passiveModule?: boolean;
  call?: { path: string; function: string };
}

const shellCommand = (event: ReuseEvent): string | undefined => {
  const command = event.type === "exec" ? event.data.command
    : event.type === "tool_start" && event.data.toolName === "bash" ? event.data.args?.command : undefined;
  return typeof command === "string" ? command : undefined;
};

function successfulShellEnd(event: ReuseEvent, runDir?: string): boolean {
  if (event.type === "exec_result") return event.data.exitCode === 0;
  if (event.type !== "tool_end" || event.data.toolName !== "bash" || event.data.isError !== false) return false;
  let result = event.data.result;
  if (result?.encoding === "gzip") {
    if (!runDir) return false;
    try { result = JSON.parse(gunzipSync(readFileSync(join(runDir, result.path))).toString("utf8")); }
    catch { return false; }
  }
  // Native bash omits exitCode on success. A background/service launch is only
  // acceptance, not a completed command; never turn it into positive reuse.
  if (!result || result.isError || result.details?.timedOut || result.details?.service) return false;
  const details = result.details ?? {};
  return (details.exitCode === undefined || details.exitCode === 0)
    && (!details.async || details.async.state === "completed");
}

function parsePython(events: ReuseEvent[]) {
  const inputs = events.flatMap<{ seq: number; command?: string; source?: string }>(event => {
    const command = shellCommand(event);
    if (command !== undefined) return [{ seq: event.seq, command }];
    const args = event.data.args;
    if (event.type === "tool_start" && event.data.toolName === "write" && typeof args?.path === "string"
      && args.path.endsWith(".py") && typeof args.content === "string") return [{ seq: event.seq, source: args.content }];
    return [];
  });
  if (!inputs.length) return new Map<number, PythonEvidence>();
  const parsed = spawnSync("python3", [new URL("./reuse-python.py", import.meta.url).pathname], { input: JSON.stringify(inputs), encoding: "utf8" });
  if (parsed.status !== 0) throw new Error(`Python evidence parser failed: ${parsed.stderr || parsed.error}`);
  return new Map<number, PythonEvidence>(
    JSON.parse(parsed.stdout).map((item: any) => [item.seq, item]));
}

/** Judge the environment's facts and causality; agent prose is never a verdict. */
export function evaluateReuse(all: ReuseEvent[], epoch: string, runDir?: string): CaseOutcome {
  const events = all.filter(event => event.trace.epoch === epoch).sort((a, b) => a.seq - b.seq);
  const benchmark = (type: string) => events.filter(event => event.type === type && event.source?.component === "benchmark");
  const baseline = benchmark("benchmark_reuse_workspace")[0];
  const before = new Set<string>(baseline?.data.pythonFiles ?? []);
  const python = parsePython(events);
  const writes = events.flatMap(event => {
    const parsed = python.get(event.seq);
    if (!parsed?.functions) return [];
    const path = posix.normalize(event.data.args.path);
    const end = events.find(end => end.type === "tool_end" && spanKey(end) === spanKey(event)
      && end.seq > event.seq && end.data.isError === false);
    return end && !path.startsWith("../") && !posix.isAbsolute(path) && !before.has(path)
      ? [{ event, end, path, ...parsed }] : [];
  });
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
    const created = newCapabilities.find(item => item.id === id);
    if (!created) return [];
    const delivered = orders.filter(({ execution }) => isDescendant(execution, key));
    return delivered.length ? [{ event, id, key, route: "controller", evidence: [created.event.seq, event.seq, result.seq], orders: delivered }] : [];
  });
  const localCalls = events.filter(event => event.type === "python_call_start" && event.source?.component === "workspace").flatMap(event => {
    const key = spanKey(event), id = publicId(event.data.origin);
    const result = events.find(result => result.type === "python_call_end" && spanKey(result) === key
      && result.seq > event.seq && result.data.outcome === "success" && result.data.codeSHA === event.data.codeSHA);
    const created = newCapabilities.find(item => item.id === id);
    if (!key || !id || !created || !result || !event.data.codeSHA
      || calls.some(call => isDescendant(event, call.key))) return [];
    const delivered = orders.filter(({ execution }) => execution.seq > event.seq && execution.seq < result.seq
      && isDescendant(execution, key));
    return delivered.length ? [{ event, id, key, route: "local", evidence: [created.event.seq, event.seq, result.seq], orders: delivered }] : [];
  });
  calls.push(...localCalls);
  const directCalls = events.filter(event => shellCommand(event) !== undefined).flatMap(event => {
    const call = python.get(event.seq)?.call, key = spanKey(event);
    if (!call || !key) return [];
    const write = writes.filter(write => write.path === call.path && write.end.seq < event.seq).at(-1);
    const result = events.find(result => spanKey(result) === key && result.seq > event.seq
      && successfulShellEnd(result, runDir));
    if (!write?.passiveModule || !write.effectfulFunctions?.includes(call.function) || !result) return [];
    const delivered = orders.filter(({ execution }) => execution.seq > event.seq && execution.seq < result.seq
      && isDescendant(execution, key) && !calls.some(call => isDescendant(execution, call.key)));
    return delivered.length ? [{ event, id: publicId(call)!, key, route: "import",
      evidence: [write.event.seq, write.end.seq, event.seq, result.seq], orders: delivered }] : [];
  });
  calls.push(...directCalls);
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
  const distinctNew = new Set([...newCapabilities.map(item => item.id),
    ...writes.flatMap(write => write.functions!.map(name => publicId({ path: write.path, function: name })!))]);
  const evidence = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  // On a negative result these references delimit the inspected run; they are
  // inspection scope, not positive evidence that discovery or reuse happened.
  const discoveryScope = evidence([...(baseline ? [baseline.seq] : []), ...discoveries.map(event => event.seq), ...(finish ? [finish.seq] : [])]);
  const reuseScope = evidence([...discoveryScope, ...phases.map(event => event.seq),
    ...events.filter(event => shellCommand(event) !== undefined).map(event => event.seq),
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
      { id: "capability-created", label: "Agent 创建 Python 函数", passed: distinctNew.size > 0,
        expected: "空白基线之后创建可解析的 Python 函数，不要求装饰器", actual: `${distinctNew.size} 个新函数`,
        evidenceSeq: evidence([...newCapabilities.map(item => item.event.seq), ...writes.flatMap(write => [write.event.seq, write.end.seq])]) },
      { id: "capability-reused", label: "跨批有效复用自写函数", passed: reused.size > 0 ? true : null,
        expected: "直接 import、本地 API 或通过 controller 调用同一自写函数，在两批、不同模型轮次中成功执行并完成订单",
        actual: reused.size ? `${reused.size} 个函数跨批复用，第二批 ${transferCalls.length} 次有效调用`
          : "未找到足以证明跨批复用的调用证据；复杂脚本未做执行追踪，结果待定",
        evidenceSeq: reused.size ? evidence(reusedCalls.flatMap(call => [...call.evidence,
          ...call.orders.flatMap(item => [item.order.seq, item.execution.seq])])) : reuseScope },
    ],
    metrics: [
      { id: "orders-completed", label: "完成订单", value: completed.size, unit: "orders", direction: "higher" },
      { id: "new-capabilities", label: "新函数（诊断）", value: distinctNew.size, unit: "functions", direction: "none" },
      { id: "productive-capability-calls", label: "跨批函数有效调用", value: reusedCalls.length, unit: "calls", direction: "none" },
      { id: "productive-reuse-calls", label: "第二批有效复用", value: transferCalls.length, unit: "calls", direction: "higher" },
      { id: "controller-discovered", label: "Controller 主动发现能力（诊断）", value: new Set(explicitlyDiscovered.map(item => item.id)).size, unit: "capabilities", direction: "none" },
      { id: "controller-productive-calls", label: "注册函数经 Controller 有效调用（诊断）", value: calls.filter(call => call.route === "controller").length, unit: "calls", direction: "none" },
      { id: "local-productive-calls", label: "工作区进程内有效调用（诊断）", value: localCalls.length, unit: "calls", direction: "none" },
      { id: "import-productive-calls", label: "直接 import 有效调用（诊断）", value: directCalls.length, unit: "calls", direction: "none" },
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
      "本地装饰器调用依据匹配源码版本的成功终态与后代设备订单归因；已计入外部 runner 的子调用不重复计数。",
      "直接 import 根据成功写入的源码、简单 Python shell 命令的 AST、原生工具成功终态及同一调用链的订单判定；不执行工作区代码。仅后台启动成功、复杂脚本和动态导入等未覆盖时保留待定，不等于没有学会。",
      "两批难度相近但不是严格对照实验，请求/订单变化仅作诊断。",
      "这是合作式 Agent 的功能评测，workspace 没有对恶意篡改日志做安全隔离。",
    ],
  };
}
