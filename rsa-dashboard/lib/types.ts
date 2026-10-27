export interface Event {
  source?: {
    component: string;
    implementation?: string;
    implementationVersion?: string;
  };
  origin?: {
    eventId: string;
    clockId: string;
    seq: number;
    at: string;
    atMs: number;
  };
  seq: number;
  at: string;
  atMs: number;
  type: string;
  trace: Record<string, string>;
  data: Record<string, any>;
}
export interface Manifest {
  kind?: string;
  parentRunId?: string;
  benchmark?: { id: string; revision: string; protocolVersion: string };
  shiori?: { implementation: string; implementationVersion: string } | null;
  runId: string;
  workspace: string;
  socket: string;
  drivers: { id: string; version: string }[];
  model: string | null;
  seconds: number;
  maxRequests: number;
  compactionThreshold: number | null;
}
export interface RunInfo {
  kind?: string;
  benchmark?: Manifest["benchmark"];
  id: string;
  model: string | null;
  seconds: number;
  drivers: { id: string; version: string }[];
}
export interface Project {
  id: string;
  workspace?: string;
  runs: RunInfo[];
}
export interface Observation {
  id: string;
  at: string;
  controller: string;
  origin: string;
  mediaType: string;
  mediaStorage?: "timeline" | "run" | "unrecorded";
  timeline?: { recordId?: string; sequence?: number; asset: string };
  text?: string;
  hook?: { id: string; codeSHA: string; path: string };
  perception?: PerceptionRead;
  sourceSequence?: number;
  sourceSequenceDelta?: number;
  afterExecutionMs?: number;
  captureMs?: number;
  encodeMs?: number;
  modelCallId?: string;
  request?: { controllerId: string; arguments?: Record<string, unknown>; argv?: string[] };
}
export interface PerceptionStatus {
  state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
  generation: string | null;
  pid?: number;
  codeSHA?: string;
  error?: string;
}
export interface PerceptionRead {
  at: string;
  status: PerceptionStatus;
  snapshot?: PerceptionSnapshot;
  records?: { snapshot: PerceptionSnapshot; text: string; observations: { id: string }[] }[];
  query?: { at?: string; start?: string; end?: string; limit?: number; after?: number; capability?: string; id?: string };
  hasMore?: boolean;
  nextAfter?: number;
  reused?: boolean;
  durationMs?: number;
  error?: string;
}
export interface PerceptionSnapshot {
  id: string;
  sequence: number;
  timeline?: { recordId: string; sequence: number };
  capability?: string;
  generation: string | null;
  recordedAt: string;
  sampling: { clock: string; startedAtMs: number; finishedAtMs: number };
  sampledAt?: string;
  sources?: unknown[];
}
export interface Tool {
  id: string;
  name: string;
  intent: string;
  args: Record<string, any>;
  at: string;
  ok: boolean | null;
  commandMs: number | null;
  durationMs: number | null;
}
export interface Call {
  id: string;
  index: number;
  at: string;
  atMs: number;
  durationMs: number | null;
  headersMs: number | null;
  firstStreamMs: number | null;
  wireBytes: number | null;
  transport: "websocket" | "sse" | null;
  transportDetails: {
    sizeBlockedUntilCompaction?: boolean;
    retryWebsocketAt?: number;
    websocketDisabled?: boolean;
  } | null;
  frameBytes: number | null;
  incremental: boolean | null;
  wsFrames: number;
  inputTokens: number;
  cachedTokens: number;
  cacheHit: number | null;
  attempts: number;
  status: string;
  error?: string;
  tools: Tool[];
  observations: string[];
  inputObservations: string[];
  inputText?: string;
  perception?: PerceptionRead;
  actions: number;
  phases: Record<string, number | null>;
}
export interface Notice {
  seq: number;
  at: string;
  type: string;
  text: string;
  modelCallId?: string;
  details?: { label: string; value: string }[];
  failed?: boolean;
}
export interface SkillEvidence {
  seq: number;
  at: string;
  action: string;
  path: string;
  hash?: string;
  modelCallId?: string;
  ok: boolean | null;
}
export interface LiveStatus {
  runId: string;
  mode: string;
  epoch: string | null;
  connected: boolean;
  reason: string;
  agent: boolean;
  thinking: boolean;
  maxSeconds?: number;
}
export interface LivePhase {
  kind:
    | "prepare"
    | "headers"
    | "first-stream"
    | "ws-first-event"
    | "stream"
    | "command"
    | "tool"
    | "capture"
    | "observation"
    | "perception"
    | "compaction"
    | "idle";
  label: string;
  startedAt: string | null;
  elapsedMs: number | null;
  sourceSeq: number;
}
export type SpanOutcome =
  "success" | "error" | "cancelled" | "pending" | "unknown";
export interface TraceSpan {
  id: string;
  kind:
    | "shiori"
    | "capability"
    | "python"
    | "python-local"
    | "discovery"
    | "device"
    | "perception"
    | "compaction"
    | "compaction-http";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  modelCallId?: string;
  toolCallId?: string;
  operationId?: string;
  source?: Event["source"];
  name: string;
  operation?: string;
  startedAt: string;
  endedAt: string | null;
  startSeq: number;
  endSeq: number | null;
  outcome: SpanOutcome;
  durationMs: number | null;
  codeSHA?: string;
  error?: string;
}
export interface SpanStats {
  started: number;
  outcomes: Record<SpanOutcome, number>;
  durationMs: { median: number | null; p95: number | null };
}
export interface NativeLoop {
  traceId: string;
  spanId: string;
  at: string;
  source?: Event["source"];
  summary: Record<string, unknown>;
  coverage: Record<string, unknown>;
}
export interface RunTelemetry {
  sources: { component: string; count: number }[];
  spans: TraceSpan[];
  shiori: { stats: SpanStats; nativeLoops: NativeLoop[] };
  capabilities: { stats: SpanStats; python: SpanStats; localPython: SpanStats; discovery: SpanStats };
  devices: SpanStats;
  perception: SpanStats;
}
export interface RunData {
  project: string;
  run: string;
  manifest: Manifest;
  cycles: { epoch: string; startedAt: string }[];
  selectedEpoch: string | null;
  calls: Call[];
  selectedCall?: Call;
  paging: { totalCalls: number; beforeCall: number | null; hasMore: boolean; firstIndex: number; lastIndex: number };
  observations: Observation[];
  perception: PerceptionStatus | null;
  notices: Notice[];
  skills: SkillEvidence[];
  telemetry: RunTelemetry;
  lastControl: Record<string, any> | null;
  activeCompaction: {
    startedAt: string;
    elapsedMs: number;
    reason: string;
  } | null;
  live: LiveStatus | null;
  livePhase: LivePhase | null;
  controlAllowed: boolean;
  controlReason: string;
  updatedAt: string;
  summary: {
    completed: number;
    actions: number;
    explicitObserves: number;
    errors: number;
    compactions: number;
    medianMs: number | null;
    p95Ms: number | null;
    medianHeadersMs: number | null;
    medianHttpHeadersMs: number | null;
    medianWsWaitMs: number | null;
    cacheHit: number | null;
    warmCacheHit: number | null;
    elapsedSeconds: number;
  };
}
