import type { Event, LivePhase, LiveStatus } from "./types";

const labels: Record<LivePhase["kind"], string> = {
  prepare: "准备模型请求",
  headers: "等待 HTTP 响应头",
  "first-stream": "等待首个流事件",
  "ws-first-event": "等待模型首事件",
  stream: "接收模型流",
  command: "执行命令",
  tool: "工具处理中",
  capture: "采集观测",
  observation: "整理观测",
  compaction: "OMP 正在压缩历史",
  idle: "等待下一步",
};

type Pending = {
  kind: LivePhase["kind"];
  event: Event;
  order: number;
  owner: string;
  httpId?: string;
  requestId?: string;
  transport?: "websocket" | "sse";
  images?: Set<string>;
  uncertainStart?: boolean;
};

// This is a view of logged operations, not a second scheduler. A completion may
// only change its own operation; late events cannot end a newer HTTP/tool/capture.
export function getLivePhase(
  events: Event[],
  run: string,
  epoch: string | null,
  live: LiveStatus | null,
  now = Date.now(),
): LivePhase | null {
  if (!epoch || live?.runId !== run || live.epoch !== epoch ||
      !live.connected || live.mode !== "auto") return null;

  const pending = new Map<string, Pending>();
  let compactionCount = 0;
  let idle: Event | undefined;
  const start = (key: string, kind: Pending["kind"], event: Event, owner: string) => {
    pending.set(key, { kind, event, owner, order: event.seq });
  };
  const finish = (key: string, event: Event) => {
    if (pending.delete(key)) idle = event;
  };
  for (const event of events) {
    if (event.trace.epoch !== epoch) continue;
    const { type, trace: t, data: d } = event;
    const owner = JSON.stringify([t.epoch, t.modelCallId, t.toolCallId]);
    const modelKey = `model:${t.modelCallId}`;
    const toolKey = `tool:${owner}`;
    const captureKey = `capture:${owner}:${t.operationId}`;
    const model = pending.get(modelKey);
    const tool = pending.get(toolKey);
    const capture = pending.get(captureKey);
    switch (type) {
      case "control":
        if (d.mode === "auto") idle = event;
        else {
          pending.clear();
          compactionCount = 0;
          idle = undefined;
        }
        break;
      case "model_start":
        start(modelKey, "prepare", event, owner);
        break;
      case "model_request":
        if (model) {
          if (model.kind !== "prepare") model.event = event;
          model.kind = "prepare";
          model.httpId = undefined;
          model.requestId = t.requestId;
          model.transport = d.transport === "websocket" ? "websocket" : undefined;
        }
        break;
      case "model_ws_dispatch":
        if (model?.transport === "websocket" && t.requestId && model.requestId === t.requestId) {
          model.kind = "ws-first-event";
          model.event = event;
        }
        break;
      case "model_http_dispatch":
        if (model && t.httpId) {
          model.transport = "sse";
          model.kind = "headers";
          model.event = event;
          model.httpId = t.httpId;
        }
        break;
      case "model_http_end":
      case "model_http_error":
        if (model?.httpId === t.httpId && t.httpId && model.kind === "headers") {
          model.kind = type === "model_http_end" && d.status < 400 ? "first-stream" : "idle";
          model.event = event;
        }
        break;
      case "model_stream_start":
        if (model && (
          (model.kind === "first-stream" && t.httpId && model.httpId === t.httpId) ||
          (model.kind === "ws-first-event" && t.requestId && model.requestId === t.requestId)
        )) {
          model.kind = "stream";
          model.event = event;
        }
        break;
      case "model_end":
        finish(modelKey, event);
        break;
      case "tool_start":
        start(toolKey, "tool", event, owner);
        break;
      case "exec":
      case "exec_result":
        if (tool && (type === "exec" || tool.kind === "command")) {
          tool.kind = type === "exec" ? "command" : "tool";
          tool.event = event;
        }
        break;
      case "tool_end":
        finish(toolKey, event);
        for (const [key, operation] of pending)
          if (operation.owner === owner && key.startsWith("capture:")) finish(key, event);
        break;
      case "observation_start":
        if (t.operationId) start(captureKey, "capture", event, owner);
        break;
      case "observation_end":
        if (capture?.kind === "capture") {
          if (d.observations?.length) {
            capture.kind = "observation";
            capture.event = event;
            capture.images = new Set(d.observations);
          } else finish(captureKey, event);
        }
        break;
      case "observation_error":
        finish(captureKey, event);
        break;
      case "observation_media":
      case "observation_context": {
        // Media has observationId but no operationId. Keep all images from the
        // matching capture pending until they finish; this is not encode timing.
        const ids: string[] = type === "observation_media" ? [d.observationId] : d.observations ?? [];
        for (const [key, operation] of pending) {
          if (operation.owner !== owner || !operation.images) continue;
          for (const id of ids) operation.images.delete(id);
          if (!operation.images.size) finish(key, event);
        }
        break;
      }
      case "auto_compaction_start":
        // Native lifecycle events have no operation ID. Overlapping starts prove
        // pending work, but cannot identify the remaining operation's start time.
        if (++compactionCount === 1) start("compaction", "compaction", event, owner);
        else pending.get("compaction")!.uncertainStart = true;
        break;
      case "auto_compaction_end":
        if (compactionCount && --compactionCount === 0) finish("compaction", event);
        break;
      // compaction_http_* is independent background work, never a blocking phase.
    }
  }
  const phase = pending.get("compaction") ?? [...pending.values()].sort((a, b) => b.order - a.order)[0];
  const event = phase?.event ?? idle;
  if (!event) return null;
  const kind = phase?.kind ?? "idle";
  return {
    kind,
    label: labels[kind],
    startedAt: phase?.uncertainStart ? null : event.at,
    elapsedMs: phase?.uncertainStart ? null : Math.max(0, now - Date.parse(event.at)),
    sourceSeq: event.seq,
  };
}
