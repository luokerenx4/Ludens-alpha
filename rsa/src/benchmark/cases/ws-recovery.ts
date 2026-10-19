import type { Context } from "@oh-my-pi/pi-ai/types";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { ModelTrace } from "../../harness/omp/trace.ts";
import type { BenchmarkContext, CaseOutcome } from "../types.ts";
import { codexTransport, fixtureModel, inputTexts, userMessage } from "../fixtures/codex-transport.ts";
import { readEvents, seqs } from "../fixtures/evidence.ts";

export async function run(ctx: BenchmarkContext): Promise<CaseOutcome> {
  ctx.signal?.throwIfAborted();
  const transport = codexTransport();
  const originalNow = Date.now;
  let virtualNow = originalNow();
  Date.now = () => virtualNow;
  const epoch = crypto.randomUUID();
  const record = ctx.log.recorder({ component: "benchmark" });
  const trace = new ModelTrace(ctx.log, () => ({ epoch }));
  const stream = trace.wrap(transport.stream as StreamFn);
  const initialText = `seed-${ctx.seed}:` + "stable history ".repeat(4_096);
  let history: Context = { messages: [userMessage(initialText)] };
  const results: string[] = [];
  const outputs: string[] = [];
  const durations: number[] = [];
  const step = async (name: string, text?: string) => {
    ctx.signal?.throwIfAborted();
    if (text) history = { messages: [...history.messages, userMessage(text)] };
    const began = performance.now();
    const response = await (await stream(fixtureModel, history, { ...transport.options, signal: ctx.signal })).result();
    ctx.signal?.throwIfAborted();
    durations.push(performance.now() - began); results.push(response.stopReason);
    outputs.push(response.content.filter(block => block.type === "text").map(block => block.text).join(""));
    history = { messages: [...history.messages, response] };
    record("benchmark_transport_step", { name, stopReason: response.stopReason, details: transport.details(),
      frames: transport.frames.length, httpRequests: transport.http.length, connections: transport.sockets.length,
      durationMs: durations.at(-1), output: outputs.at(-1) }, { epoch });
    return response;
  };
  let fallbackValid = false, cooldownValid = false, restoredValid = false, deltaValid = false;
  let noReplay = false, delivered = 0;
  let fullBytes = 0, deltaBytes = 0;
  try {
    await step("initial-ws");
    transport.onSend(socket => {
      // Empty reasoning was the observed precursor to the production expiry.
      socket.message({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_empty", summary: [], content: [] } });
      socket.expire();
    });
    record("benchmark_fault", { kind: "websocket-expiry", virtualCooldownMs: 60_000 }, { epoch });
    await step("expiry-to-sse", "request-two");
    fallbackValid = transport.http.length === 1 && transport.frames.length === 2
      && JSON.stringify(inputTexts(transport.http[0]!)) === JSON.stringify([initialText, "request-two"])
      && transport.details().retryWebsocketAt === virtualNow + 60_000;
    virtualNow += 59_999;
    await step("cooldown-sse", "request-three");
    cooldownValid = transport.sockets.length === 1 && transport.frames.length === 2 && transport.http.length === 2;
    virtualNow += 2;
    transport.onSend(socket => transport.complete(socket));
    await step("restored-full-ws", "request-four");
    const restored = transport.frames[2];
    fullBytes = transport.frameBytes[2] ?? 0;
    restoredValid = transport.sockets.length === 2 && transport.http.length === 2 && !!restored
      && restored.previous_response_id === undefined && transport.details().retryWebsocketAt === undefined
      && JSON.stringify(inputTexts(restored)) === JSON.stringify([initialText, "request-two", "request-three", "request-four"]);
    await step("restored-delta-ws", "request-five");
    const delta = transport.frames[3];
    deltaBytes = transport.frameBytes[3] ?? 0;
    deltaValid = transport.http.length === 2 && !!delta && delta.previous_response_id === "ws_3"
      && JSON.stringify(inputTexts(delta)) === JSON.stringify(["request-five"]);
    transport.onSend(socket => {
      const item = { type: "function_call", id: "fc_once", call_id: "call_once", name: "move", arguments: "" };
      socket.message({ type: "response.output_item.added", item });
      socket.message({ type: "response.output_item.done", item: { ...item, arguments: "{}" } });
      socket.expire();
    });
    const before = transport.http.length;
    ctx.signal?.throwIfAborted();
    const partial = await stream(fixtureModel, { messages: [...history.messages, userMessage("use one tool")] }, { ...transport.options, signal: ctx.signal });
    for await (const event of partial) if (event.type === "toolcall_end") delivered++;
    const partialResult = await partial.result();
    ctx.signal?.throwIfAborted();
    noReplay = delivered === 1 && transport.http.length === before && partialResult.stopReason === "error";
    record("benchmark_no_replay", { delivered, httpBefore: before, httpAfter: transport.http.length,
      stopReason: partialResult.stopReason }, { epoch });
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { Date.now = originalNow; transport.close(); }
  const events = await readEvents(ctx.runDir);
  const evidence = seqs(events, e => e.type === "benchmark_transport_step" || e.type === "benchmark_fault");
  return {
    checks: [
      { id: "responses-completed", label: "正常请求完整完成", passed: results.length === 5 && results.every(reason => reason === "stop") && outputs.every(text => text === "OK"),
        expected: "前五个正常请求均 stop 且输出 OK；最后的故障注入请求单独判定", actual: JSON.stringify({ stopReasons: results, outputs }), evidenceSeq: evidence },
      { id: "fallback", label: "到期后安全回退", passed: fallbackValid,
        expected: "到期请求经 SSE 完成、完整历史保留、进入 60 秒冷却", actual: `${transport.http.length} 个 SSE 请求；${results.join(", ")}`, evidenceSeq: evidence },
      { id: "cooldown", label: "冷却期不重复握手", passed: cooldownValid,
        expected: "冷却期继续 SSE，无新 WS 连接", actual: `verified=${cooldownValid}`, evidenceSeq: evidence },
      { id: "restore", label: "恢复 WS 全历史", passed: restoredValid,
        expected: "冷却后新连接使用完整历史，无 previous_response_id", actual: `verified=${restoredValid}; full=${fullBytes} B`, evidenceSeq: evidence },
      { id: "delta", label: "恢复增量链", passed: deltaValid,
        expected: "下一请求引用恢复后的 response，仅发送新输入", actual: `verified=${deltaValid}; delta=${deltaBytes} B`, evidenceSeq: evidence },
      { id: "no-tool-replay", label: "已交付工具不重放", passed: noReplay,
        expected: "工具已输出后的到期不自动 SSE 重试，工具只交付一次", actual: `delivered=${delivered}; verified=${noReplay}`,
        evidenceSeq: seqs(events, e => e.type === "benchmark_no_replay" || e.type === "model_end" && e.data.stopReason === "error") },
    ],
    metrics: [
      { id: "restored", label: "WS 恢复成功", value: restoredValid && deltaValid ? 1 : 0, unit: "boolean" },
      { id: "sse-requests", label: "SSE 回退请求", value: transport.http.length, unit: "count" },
      { id: "connections", label: "WS 连接", value: transport.sockets.length, unit: "count" },
      { id: "full-frame-bytes", label: "恢复全量帧", value: fullBytes, unit: "B" },
      { id: "delta-frame-bytes", label: "恢复后增量帧", value: deltaBytes, unit: "B" },
      { id: "delta-ratio", label: "增量/全量字节", value: fullBytes ? deltaBytes / fullBytes * 100 : null, unit: "%" },
      { id: "local-request-ms", label: "本地请求平均耗时", value: durations.reduce((a, b) => a + b, 0) / durations.length, unit: "ms" },
    ],
    limitations: ["运行真实 OMP Codex provider 和 ModelTrace；WS/SSE 均为进程内传输 fixture，不访问在线模型。", "通过虚拟 Date.now 推进 60 秒冷却；计时使用真实 performance.now，只反映本地处理开销。", "无重放场景故意产生一次 model_end:error，这是预期故障证据。"],
  };
}
