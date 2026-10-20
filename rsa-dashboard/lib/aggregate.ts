import type { Event, Call, Observation, Notice, SkillEvidence, PerceptionRead } from "./types";
import { p95 } from "./telemetry";
import { eventObservations, observationExecution, perceptionStatus } from "./observation-events";
export function parseEvents(text: string): Event[] {
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // An append in progress is not a malformed event.
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
    : null;
};
const finite = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
export function selectCycle(events: Event[], epoch?: string) {
  const cycles = events
    .filter(
      (event) =>
        event.type === "control" &&
        event.data.mode === "auto" &&
        event.trace.epoch,
    )
    .map((event) => ({ epoch: event.trace.epoch, startedAt: event.at }));
  const selectedEpoch = epoch ?? cycles.at(-1)?.epoch ?? null;
  if (epoch !== undefined && !cycles.some((cycle) => cycle.epoch === epoch))
    throw new Error("所选周期不属于当前运行");
  return {
    cycles,
    selectedEpoch,
    events: selectedEpoch
      ? events.filter((event) => event.trace.epoch === selectedEpoch)
      : [],
  };
}
export function aggregate(events: Event[], now = Date.now()) {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  const observations: Observation[] = [];
  const observationMap = new Map<string, Observation>();
  const observationRequests = new Map<string, Observation["request"]>();
  const observationResults = new Map<string, { text: string; perception?: PerceptionRead }>();
  const contexts = new Map<string, { observations: string[]; executions: string[] }>();
  const notices: Notice[] = [];
  const skills: SkillEvidence[] = [];
  const toolMap = new Map<
    string,
    { tool: Call["tools"][number]; startedAtMs: number; execAtMs?: number }
  >();
  const skillTools = new Map<string, SkillEvidence[]>();
  let lastControl: Record<string, any> | null = null;
  let compaction: { startedAt: string; reason: string } | null = null;
  let compactionHttpCount = 0;
  const compactionHttpAttempts = new Map<string, number>();
  let autoStarted: number | undefined;
  let elapsedMs = 0;
  const executionErrors = new Set(events
    .filter(event => event.type === "execution_error" && event.trace.traceId && event.trace.spanId)
    .map(event => JSON.stringify([event.trace.epoch, event.trace.traceId, event.trace.spanId])));
  for (const event of events) {
    const d = event.data;
    const t = event.trace;
    const toolKey = JSON.stringify([t.epoch, t.modelCallId, t.toolCallId]);
    const observationKey = JSON.stringify([t.epoch, t.operationId]);
    const observed = observationExecution(event);
    if (observed?.result) observationResults.set(JSON.stringify([t.epoch, observed.result.id]), {
      text: observed.result.stdout, perception: observed.perception,
    });
    if (event.type === "context")
      contexts.set(t.epoch, { observations: d.observations ?? [], executions: d.executions ?? [] });
    if (event.type === "observation_start" && t.operationId)
      observationRequests.set(observationKey, { controllerId: d.controllerId ?? d.sensorId, argv: d.argv });
    if (event.type === "auto_compaction_start") {
      compaction = {
        startedAt: event.at,
        reason: String(d.reason ?? d.action ?? ""),
      };
      compactionHttpCount = 0;
    }
    if (event.type === "auto_compaction_end") compaction = null;
    let call = byId.get(t.modelCallId);
    if (event.type === "model_start") {
      const context = contexts.get(t.epoch);
      const inputResults = context && JSON.stringify(context.observations) === JSON.stringify(d.observations ?? [])
        ? context.executions.flatMap(id => {
          const result = observationResults.get(JSON.stringify([t.epoch, id]));
          return result ? [result] : [];
        }) : [];
      const inputText = inputResults.map(result => result.text).filter(Boolean).join("\n\n");
      const perception = inputResults.findLast(result => result.perception)?.perception;
      call = {
        id: t.modelCallId,
        index: calls.length + 1,
        at: event.at,
        atMs: event.atMs,
        durationMs: null,
        headersMs: null,
        firstStreamMs: null,
        wireBytes: null,
        transport: null,
        transportDetails: d.transportDetails ?? null,
        frameBytes: null,
        incremental: null,
        wsFrames: 0,
        inputTokens: 0,
        cachedTokens: 0,
        cacheHit: null,
        attempts: 0,
        status: "pending",
        tools: [],
        observations: [],
        inputObservations: d.observations ?? [],
        ...(inputText ? { inputText } : {}),
        ...(perception ? { perception } : {}),
        actions: 0,
        phases: {},
      };
      calls.push(call);
      byId.set(call.id, call);
    }
    if (event.type === "control") {
      lastControl = { ...d, at: event.at };
      if (d.mode === "auto") autoStarted = Date.parse(event.at);
      else if (autoStarted !== undefined) {
        elapsedMs += Date.parse(event.at) - autoStarted;
        autoStarted = undefined;
      }
    }
    if (event.type === "model_request" && call) {
      call.transport = d.transport === "websocket" ? "websocket" : null;
      call.frameBytes = call.transport === "websocket" ? finite(d.bodyBytes) : null;
      call.incremental = call.transport === "websocket" && typeof d.incremental === "boolean"
        ? d.incremental : null;
    }
    if (event.type === "model_ws_dispatch" && call) {
      call.transport = "websocket";
      call.frameBytes = finite(d.bodyBytes);
      call.wsFrames++;
    }
    if (event.type === "model_stream_start" && call) {
      call.firstStreamMs = finite(d.modelElapsedMs);
      call.phases.afterDispatchMs = finite(d.afterDispatchMs);
    }
    if (event.type === "model_http_start" && call) {
      call.transport = "sse";
      call.wireBytes = finite(d.body?.bytes);
      call.attempts++;
      if (call.attempts === 1)
        call.phases.preparationMs = event.atMs - call.atMs;
    }
    if (event.type === "model_http_end" && call) {
      const duration = finite(d.fetchToHeadersMs) ?? finite(d.durationMs);
      if (duration !== null) call.headersMs = (call.headersMs ?? 0) + duration;
      call.phases.headersAtMs = event.atMs;
    }
    if (event.type === "model_http_error" && call) {
      const duration = finite(d.fetchDurationMs) ?? finite(d.durationMs);
      if (duration !== null) call.headersMs = (call.headersMs ?? 0) + duration;
    }
    if (event.type === "model_end" && call) {
      if (d.transportDetails !== undefined) call.transportDetails = d.transportDetails;
      call.durationMs = finite(d.durationMs);
      call.status = d.stopReason ?? "done";
      call.error = d.error;
      call.inputTokens =
        (d.usage?.input ?? 0) +
        (d.usage?.cacheRead ?? 0) +
        (d.usage?.cacheWrite ?? 0);
      call.cachedTokens = d.usage?.cacheRead ?? 0;
      call.cacheHit = call.inputTokens
        ? call.cachedTokens / call.inputTokens
        : null;
      call.firstStreamMs = finite(d.firstStreamEventMs);
      for (const key of [
        "payloadCaptureMs",
        "httpInspectionMs",
        "streamLogMs",
        "afterFirstStreamMs",
      ])
        call.phases[key] = finite(d[key]);
      if (call.phases.headersAtMs != null)
        call.phases.afterHeadersMs = event.atMs - call.phases.headersAtMs;
    }
    if (event.type === "tool_start" && call) {
      const tool = {
        id: t.toolCallId,
        name: d.toolName,
        intent: d.intent ?? "",
        args: d.args ?? {},
        at: event.at,
        ok: null,
        commandMs: null,
        durationMs: null,
      };
      call.tools.push(tool);
      toolMap.set(toolKey, { tool, startedAtMs: event.atMs });
      if (["read", "edit", "write"].includes(tool.name)) {
        const paths: string[] = tool.args.path
          ? [String(tool.args.path)]
          : [
              ...new Set(
                [
                  ...String(tool.args.input ?? "").matchAll(
                    /^\[(skills\/[^#\]\n]+)(?:#[^\]\n]+)?\]/gm,
                  ),
                ].map((m) => m[1]),
              ),
            ];
        const evidence = paths
          .filter((p) => p.includes("skills/"))
          .map(
            (path) =>
              ({
                seq: event.seq,
                at: event.at,
                action: tool.name,
                path,
                modelCallId: call!.id,
                ok: null,
              }) as SkillEvidence,
          );
        skills.push(...evidence);
        skillTools.set(toolKey, evidence);
      }
    }
    if (event.type === "exec") {
      const timing = toolMap.get(toolKey);
      if (timing) timing.execAtMs = event.atMs;
    }
    if (event.type === "exec_result") {
      const timing = toolMap.get(toolKey);
      if (timing?.execAtMs !== undefined)
        timing.tool.commandMs = event.atMs - timing.execAtMs;
    }
    if (event.type === "tool_end") {
      const timing = toolMap.get(toolKey);
      if (timing) {
        timing.tool.ok = !d.isError;
        timing.tool.durationMs = event.atMs - timing.startedAtMs;
        for (const evidence of skillTools.get(toolKey) ?? [])
          evidence.ok = !d.isError;
      }
    }
    if (event.type === "read") {
      const evidence = skillTools
        .get(toolKey)
        ?.find((x) => x.action === "read");
      if (evidence) {
        evidence.hash = d.hash;
        evidence.ok = !d.isError;
      }
    }
    if (
      event.type === "execution" &&
      call &&
      d.requiresControl !== false &&
      d.status === "completed" &&
      d.exitCode === 0
    )
      call.actions++;
    for (const observation of eventObservations(event)) {
      const o: Observation = {
        id: observation.id,
        at: event.at,
        controller: observation.controllerId ?? observation.sensorId ?? "",
        mediaType: observation.mediaType,
        origin: observation.origin ?? "unknown",
        text: observation.text,
        hook: observation.hook,
        perception: observation.perception,
        sourceSequence: observation.sourceSequence,
        sourceSequenceDelta: observation.sourceSequenceDelta,
        afterExecutionMs: observation.afterExecution?.captureRequestedAfterMs,
        captureMs: observation.timing && !observation.perception
          ? observation.timing.receivedAtMs - observation.timing.requestedAtMs
          : undefined,
        modelCallId: t.modelCallId,
        request: t.operationId ? observationRequests.get(observationKey) : undefined,
      };
      const existing = observationMap.get(o.id);
      if (!existing) {
        observations.push(o);
        observationMap.set(o.id, o);
      } else if (o.hook || o.perception) {
        Object.assign(existing, { hook: o.hook, perception: o.perception, text: o.text, origin: o.origin });
      }
      if (call && !call.observations.includes(o.id)) call.observations.push(o.id);
    }
    if (event.type === "observation_media") {
      const o = observationMap.get(d.observationId);
      if (o) o.encodeMs = d.durationMs;
    }
    if (
      (event.type.includes("error") && !(event.type === "observation_error" && executionErrors.has(
        JSON.stringify([t.epoch, t.traceId, t.spanId]),
      ))) ||
      event.type.startsWith("auto_compaction") ||
      event.type.startsWith("compaction_http_") ||
      (event.type === "perception_observe_end" && d.status?.state === "error") ||
      event.type === "disconnected"
    ) {
      let text =
        event.type === "auto_compaction_end"
          ? `${d.result?.shortSummary ?? "压缩结束"} · ${d.result?.tokensBefore ?? "—"} tokens → 新历史`
          : (d.aborted ? "正常中止 · " : "") +
            String(
              d.error ?? d.reason ?? (typeof d === "string" ? d : event.type),
            );
      const details: { label: string; value: string }[] = [];
      if (event.type === "compaction_http_start") {
        compactionHttpAttempts.set(t.httpId, ++compactionHttpCount);
        text = `独立压缩 HTTP · 第 ${compactionHttpCount} 次请求`;
        details.push({ label: "端点", value: String(d.endpoint) });
        if (finite(d.bodyBytes) !== null)
          details.push({
            label: "请求体",
            value: `${(d.bodyBytes / 1e6).toFixed(2)} MB`,
          });
      }
      if (event.type === "compaction_http_end") {
        const wait = finite(d.fetchToHeadersMs) ?? finite(d.durationMs);
        text = `独立压缩 HTTP · 第 ${compactionHttpAttempts.get(t.httpId) ?? "—"} 次请求 · 响应头已到（非压缩完成）`;
        details.push({ label: "HTTP 状态", value: String(d.status) });
        if (wait !== null)
          details.push({
            label: "响应头前等待",
            value: `${(wait / 1000).toFixed(1)}s`,
          });
      }
      if (event.type === "compaction_http_error") {
        text = `独立压缩 HTTP · 第 ${compactionHttpAttempts.get(t.httpId) ?? "—"} 次请求 · ${d.aborted ? "正常中止" : "传输失败"} · ${d.error}`;
        const wait = finite(d.fetchDurationMs) ?? finite(d.durationMs);
        if (wait !== null)
          details.push({
            label: "失败前等待",
            value: `${(wait / 1000).toFixed(1)}s`,
          });
        if (d.code) details.push({ label: "错误码", value: String(d.code) });
      }
      if (event.type === "auto_compaction_end") {
        const remote = d.result?.preserveData?.openaiRemoteCompaction;
        const usage = remote?.usage;
        for (const [key, label] of [
          ["inputTokens", "压缩输入 tokens"],
          ["outputTokens", "压缩输出 tokens"],
          ["cachedInputTokens", "压缩缓存 tokens"],
          ["totalTokens", "压缩总 tokens"],
        ]) {
          if (finite(usage?.[key]) !== null)
            details.push({ label, value: usage[key].toLocaleString("en-US") });
        }
        if (finite(remote?.retainedImageCount) !== null)
          details.push({
            label: "保留图像",
            value: String(remote.retainedImageCount),
          });
      }
      notices.push({
        seq: event.seq,
        at: event.at,
        type: event.type,
        text,
        modelCallId: event.type.includes("compaction")
          ? undefined
          : t.modelCallId,
        details,
        failed:
          (event.type.includes("error") && !d.aborted) ||
          (event.type === "perception_observe_end" && d.status?.state === "error" && d.outcome !== "cancelled") ||
          (event.type === "compaction_http_end" && d.status >= 400),
      });
    }
  }
  if (autoStarted !== undefined) elapsedMs += Math.max(0, now - autoStarted);
  const completed = calls.filter(
    (c) => c.durationMs !== null && !["aborted", "error"].includes(c.status),
  );
  const weighted = (cs: Call[]) => {
    const tokens = cs.reduce((n, c) => n + c.inputTokens, 0);
    return tokens ? cs.reduce((n, c) => n + c.cachedTokens, 0) / tokens : null;
  };
  return {
    calls,
    observations,
    perception: perceptionStatus(events),
    notices,
    skills,
    lastControl,
    activeCompaction: compaction
      ? {
          ...compaction,
          elapsedMs: Math.max(0, now - Date.parse(compaction.startedAt)),
        }
      : null,
    summary: {
      completed: completed.length,
      actions: calls.reduce((n, c) => n + c.actions, 0),
      explicitObserves: calls.reduce(
        (n, c) => n + c.tools.filter((t) => t.name === "observe").length,
        0,
      ),
      errors: notices.filter((notice) => notice.failed).length,
      compactions: events.filter((e) => e.type === "auto_compaction_end")
        .length,
      medianMs: median(completed.map((c) => c.durationMs!)),
      p95Ms: p95(completed.map((c) => c.durationMs!)),
      medianHeadersMs: median(
        completed.flatMap((c) => (c.headersMs === null ? [] : [c.headersMs])),
      ),
      cacheHit: weighted(completed),
      warmCacheHit: weighted(completed.slice(1)),
      elapsedSeconds: elapsedMs / 1000,
    },
  };
}
