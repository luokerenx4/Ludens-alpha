import type { BenchmarkContext, AuthorReport } from "../types.ts";
import { nativeCompaction, threshold } from "../fixtures/native-compaction.ts";
import { readEvents, seqs, until } from "../fixtures/evidence.ts";

export async function run(ctx: BenchmarkContext): Promise<AuthorReport> {
  ctx.signal?.throwIfAborted();
  const record = ctx.log.recorder({ component: "benchmark" });
  const originEpoch = crypto.randomUUID(), laterEpoch = crypto.randomUUID(), cancelEpoch = crypto.randomUUID();
  let requests = 0, commits = 0, tailPreserved = false, originalLeaf = false;
  let cancellationMs = 0, cancellationSettled = false, cancelCommitted = false;
  const f = await nativeCompaction(ctx, originEpoch);
  try {
    record("benchmark_scenario", { scenario: "late-ready", thresholdTokens: threshold }, { epoch: originEpoch });
    await f.start();
    f.appendTail();
    f.changeEpoch(laterEpoch);
    record("benchmark_epoch_changed", { originalEpoch: originEpoch, newEpoch: laterEpoch }, { epoch: laterEpoch });
    const { completion } = await f.block();
    await Bun.sleep(35);
    ctx.signal?.throwIfAborted();
    f.finishResponse();
    await completion;
    ctx.signal?.throwIfAborted();
    commits = f.compactions().length; requests = f.requests.length;
    originalLeaf = f.compactions()[0]?.providerReplayThroughEntryId === f.initialLeafId;
    tailPreserved = JSON.stringify(f.agent.state.messages.slice(1)) === JSON.stringify(f.tail);
    record("benchmark_compaction_applied", { requests, commits, tailPreserved, originalLeaf,
      tailMessages: f.tail.length, retainedMessages: f.agent.state.messages.length - 1,
      historyEvidence: ctx.log.artifact({ snapshotLeafId: f.initialLeafId, compactions: f.compactions(),
        expectedTail: f.tail, actualTail: f.agent.state.messages.slice(1) }) }, { epoch: laterEpoch });
  } finally { await f.close(); }

  const cancelled = await nativeCompaction(ctx, cancelEpoch);
  try {
    record("benchmark_scenario", { scenario: "cancel-then-late-response", thresholdTokens: threshold }, { epoch: cancelEpoch });
    await cancelled.start();
    const { completion } = await cancelled.block();
    const requestedAt = performance.now();
    let settled = false;
    void completion.then(() => { settled = true; });
    cancelled.maintenance.abortCompaction(new Error("Benchmark control budget ended"));
    await until(() => settled, 5_000, ctx.signal);
    cancellationMs = performance.now() - requestedAt;
    cancellationSettled = settled && cancelled.requests[0]?.signal?.aborted === true;
    cancelled.finishResponse();
    await cancelled.maintenance.speculationCompletion;
    await Bun.sleep(10);
    ctx.signal?.throwIfAborted();
    cancelCommitted = cancelled.compactions().length > 0;
    record("benchmark_compaction_cancelled", { cancellationSettled, cancelCommitted, cancellationMs,
      requests: cancelled.requests.length, commits: cancelled.compactions().length }, { epoch: cancelEpoch });
  } finally { await cancelled.close(); }

  const events = await readEvents(ctx.runDir);
  const started = events.find(e => e.type === "compaction_speculation" && e.data.stage === "started" && e.trace.epoch === originEpoch);
  const lifecycle = events.filter(e => e.type === "compaction_speculation" && e.trace.operationId === started?.trace.operationId);
  const armed = lifecycle.find(e => e.data.stage === "armed");
  const applied = lifecycle.find(e => e.data.stage === "applied");
  const http = events.filter(e => e.type === "compaction_http_start" && e.trace.operationId === started?.trace.operationId);
  const completeIdentity = !!started?.trace.traceId && !!started.trace.spanId && !!armed && !!applied
    && lifecycle.every(e => e.trace.epoch === originEpoch && e.trace.spanId === started.trace.spanId)
    && http.length === 1 && http.every(e => e.trace.epoch === originEpoch && e.trace.parentSpanId === started.trace.spanId
      && e.trace.traceId === started.trace.traceId);
  const maintenance = events.find(e => e.type === "auto_compaction_end" && e.trace.epoch === laterEpoch);
  const headers = events.find(e => e.type === "compaction_http_end" && e.trace.httpId === http[0]?.trace.httpId);
  const headersNotReady = !!headers && !!armed && headers.atMs < armed.atMs;
  const spans = new Set(events.flatMap(e => e.trace.spanId ? [e.trace.spanId] : []));
  const orphanParents = events.filter(e => e.trace.parentSpanId && !spans.has(e.trace.parentSpanId));
  ctx.metadata.limitations = ["使用真实 OMP SessionMaintenance、原生 V2 序列化/解析、提交与历史重放；摘要内容和网络等待由本地 SSE fixture 控制。", "显式提供接近阈值的 token 计数触发维护路径；生产压缩阈值仍为 256000，不改变真实 workspace。", "取消场景含预期取消事件，不应当作真实运行故障率。"];
  return {
    checks: {
      "reuse-candidate": { label: "复用后台候选", passed: requests === 1 && commits === 1 && originalLeaf,
        expected: "一个原生 V2 摘要请求、一次提交、复用原快照", actual: JSON.stringify({ requests, commits, originalLeaf }),
        evidenceSeq: seqs(events, e => e.type === "benchmark_compaction_applied" || e.trace.operationId === started?.trace.operationId) },
      "tail-preserved": { label: "保留并发追加历史", passed: tailPreserved,
        expected: "快照后的 user/toolCall/toolResult 尾部完整且顺序相同", actual: `preserved=${tailPreserved}`,
        evidenceSeq: seqs(events, e => e.type === "benchmark_compaction_applied") },
      "late-identity": { label: "跨轮压缩归属", passed: completeIdentity && orphanParents.length === 0,
        expected: "started/armed/applied 与 HTTP 保留创建 epoch 和 operation；无悬空 parent", actual: `linked=${completeIdentity}; orphanParents=${orphanParents.length}`,
        evidenceSeq: seqs(events, e => e.type.startsWith("compaction_") || e.type === "benchmark_epoch_changed") },
      "headers-not-ready": { label: "区分响应头与摘要就绪", passed: headersNotReady,
        expected: "HTTP 响应头先到，armed 在延迟摘要完成后出现", actual: `headers=${headers?.atMs}; armed=${armed?.atMs}`,
        evidenceSeq: [headers?.seq, armed?.seq].filter((n): n is number => n !== undefined) },
      "cancel-no-commit": { label: "取消后不晚提交", passed: cancellationSettled && !cancelCommitted,
        expected: "预算取消可退出等待，晚到 provider 响应不提交摘要", actual: JSON.stringify({ cancellationSettled, cancelCommitted }),
        evidenceSeq: seqs(events, e => e.trace.epoch === cancelEpoch) },
    },
    metrics: {
      "prepare-ms": { label: "候选准备耗时", value: typeof armed?.data.durationMs === "number" ? armed.data.durationMs : null, unit: "ms" },
      "foreground-wait-ms": { label: "前台压缩维护等待", value: typeof maintenance?.data.durationMs === "number" ? maintenance.data.durationMs : null, unit: "ms" },
      "summary-requests": { label: "正常场景摘要请求", value: requests, unit: "count" },
      "duplicate-summary": { label: "多余摘要请求", value: Math.max(0, requests - 1), unit: "count" },
      "orphan-parents": { label: "悬空调用父节点", value: orphanParents.length, unit: "count" },
      "cancel-ms": { label: "取消等待退出", value: cancellationMs, unit: "ms" },
    },
  };
}
