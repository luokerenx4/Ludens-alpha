export interface Event {
  seq: number;
  at: string;
  atMs: number;
  type: string;
  trace: Record<string, string>;
  data: Record<string, any>;
}
export interface Manifest {
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
  id: string;
  model: string | null;
  seconds: number;
  drivers: { id: string; version: string }[];
}
export interface Project {
  id: string;
  runs: RunInfo[];
}
export interface Observation {
  id: string;
  at: string;
  sensor: string;
  origin: string;
  mediaType: string;
  sourceSequence?: number;
  sourceSequenceDelta?: number;
  afterExecutionMs?: number;
  captureMs?: number;
  encodeMs?: number;
  modelCallId?: string;
  request?: { sensorId: string; argv: string[] };
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
  kind: "prepare" | "headers" | "first-stream" | "ws-first-event" | "stream" | "command" | "tool" | "capture" | "observation" | "compaction" | "idle";
  label: string;
  startedAt: string | null;
  elapsedMs: number | null;
  sourceSeq: number;
}
export interface RunData {
  project: string;
  run: string;
  manifest: Manifest;
  cycles: { epoch: string; startedAt: string }[];
  selectedEpoch: string | null;
  calls: Call[];
  observations: Observation[];
  notices: Notice[];
  skills: SkillEvidence[];
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
    medianHeadersMs: number | null;
    cacheHit: number | null;
    warmCacheHit: number | null;
    elapsedSeconds: number;
  };
}
