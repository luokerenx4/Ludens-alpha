import type { LogIndex, RecordPointer } from "./log-index";
import { readArtifact } from "../../shared/log-archive";
import { aggregate, isCompletedControllerAction } from "./aggregate";
import { projectTelemetry } from "./telemetry";
import { advanceTelemetry, telemetryFromState, telemetryFactKeys, type TelemetryState, type TelemetryRecipe } from "./telemetry-reducer";
import { eventObservations, observationExecution, type ArchivedObservation } from "./observation-events";
import { advanceLivePhase, emptyLivePhase, livePhaseValue, type LivePhaseState } from "./live-phase";
import type { Call, Event, Manifest, NativeLoop, Observation, RunData, SpanStats, TraceSpan } from "./types";

const VERSION = "reducers-4";
const PAGE_SIZE = 100;
type Meta = RecordPointer;
type CycleState = { phase: LivePhaseState; lastControl: Record<string, any> | null; autoStarted?: number;
  elapsedMs: number; callCount: number; contextPosition?: number; counts: Record<string, number>; compaction: { startedAt: string; reason: string } | null };
const blankState = (): CycleState => ({ phase: emptyLivePhase(), lastControl: null, elapsedMs: 0, callCount: 0, counts: {}, compaction: null });
const epochOf = (event: Event) => event.trace?.epoch ?? "";
const identity = (...parts: unknown[]) => JSON.stringify(parts);
const spanKey = (event: Event) => identity(epochOf(event), event.trace.traceId, event.trace.spanId);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stores = ["run-calls", "run-starts", "run-observations", "run-spans", "run-loops", "run-notices", "run-skills",
  "run-states", "run-contexts", "run-inputs", "run-requests", "run-encodings", "run-cycles", "run-model-state", "run-span-state", "run-error-spans"];
const rows = (index: LogIndex, name: string) => index.store(name).entries();
async function readPage<T, R>(values: T[], read: (value: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const position = next++;
      if (position >= values.length) return;
      result[position] = await read(values[position]!);
      signal?.throwIfAborted();
    }
  }));
  return result;
}

/** Keep only the requested tail, even when a disk index has millions of rows. */
function newest(entries: Iterable<Meta>, limit: number, matches: (entry: Meta) => boolean = () => true): Meta[] {
  const result: Meta[] = [];
  for (const entry of entries) {
    if (!matches(entry)) continue;
    let low = 0, high = result.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (Number(result[middle].position) <= Number(entry.position)) low = middle + 1;
      else high = middle;
    }
    result.splice(low, 0, entry);
    if (result.length > limit) result.shift();
  }
  return result;
}

async function initialise(index: LogIndex) {
  const stamp = `${VERSION}:${index.generation}`;
  if (index.meta("run_projection") === stamp) return;
  index.resetStores(stores);
  index.setMeta("run_projection", stamp);
  index.setMeta("run_position", 0);
}

/** Disk relationships select a model/span before its event bodies are loaded. */
type EventFilter = { epoch?: string | null; model?: string; traceId?: string; spanId?: string;
  beforePosition?: number; types?: string[] };
async function relatedEvents(index: LogIndex, filter: EventFilter, signal?: AbortSignal): Promise<Event[]> {
  const result: Event[] = [];
  let position = 0;
  for (;;) {
    const batch = await index.queryEvents({ ...filter, afterPosition: position, limit: 500, signal });
    if (!batch.length) break;
    for (const row of batch) result.push(row.event);
    position = batch.at(-1)!.position;
  }
  return result;
}

async function hydrateCall(index: LogIndex, id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const start = index.store("run-starts").meta(id);
  if (!start) return;
  const events = await relatedEvents(index, { model: id, epoch: start.epoch }, signal);
  // Only skill evidence needs parameters during projection. The cache retains
  // references; full arguments are read for the selected call below.
  for (let i = 0; i < events.length; i++) {
    signal?.throwIfAborted();
    const event = events[i]!;
    if (event.type === "tool_start" && event.data.argsRef && ["read", "edit", "write"].includes(event.data.toolName))
      events[i] = { ...event, data: { ...event.data,
        args: await readArtifact(index.path, event.data.argsRef, { media: "reference", workspace: index.archiveWorkspace }) } };
    signal?.throwIfAborted();
  }
  const context = start.contextPosition ? await index.readEvent(start.contextPosition) : undefined;
  const inputs: Event[] = [];
  for (const resultId of context?.data.executions ?? []) {
    signal?.throwIfAborted();
    const inputMeta = index.store("run-inputs").meta(identity(start.epoch, resultId));
    const input = inputMeta ? await index.readEvent(inputMeta.position) : undefined;
    if (input) inputs.push(input);
  }
  const projected = aggregate([...inputs, ...(context ? [context] : []), ...events]);
  signal?.throwIfAborted();
  const call = projected.calls.find(item => item.id === id);
  if (!call) return;
  call.index = Number(start.number);
  for (const tool of call.tools) if (tool.argsRef) tool.args = {};
  return { call, skills: projected.skills };
}
type CallState = { duration: number | null; status: string; transport: "sse" | "websocket" | null;
  headers: number | null; wsWait: number | null; input: number; cached: number; observes: number };
const CALL_EVENTS = new Set(["model_start", "model_request", "model_ws_dispatch", "model_stream_start", "model_http_start", "model_http_end", "model_http_error", "model_end", "tool_start"]);
function projectCallEvent(index: LogIndex, event: Event) {
  const id = event.trace.modelCallId;
  if (!id || !CALL_EVENTS.has(event.type)) return;
  const store = index.store("run-model-state");
  const state = { ...(store.meta(id)?.state as CallState | undefined ?? {
    duration: null, status: "pending", transport: null, headers: null, wsWait: null, input: 0, cached: 0, observes: 0 }) };
  const d = event.data;
  if (event.type === "model_request") state.transport = d.transport === "websocket" ? "websocket" : null;
  if (event.type === "model_ws_dispatch") state.transport = "websocket";
  if (event.type === "model_http_start") state.transport = "sse";
  if (event.type === "model_stream_start") state.wsWait = finite(d.afterDispatchMs) ? d.afterDispatchMs : null;
  if (event.type === "model_http_end" || event.type === "model_http_error") {
    const value = event.type === "model_http_end" ? d.fetchToHeadersMs : d.fetchDurationMs;
    const duration = finite(value) ? value : finite(d.durationMs) ? d.durationMs : null;
    if (duration !== null) state.headers = (state.headers ?? 0) + duration;
  }
  if (event.type === "model_end") {
    state.duration = finite(d.durationMs) ? d.durationMs : null;
    state.status = d.stopReason ?? "done";
    state.input = (d.usage?.input ?? 0) + (d.usage?.cacheRead ?? 0) + (d.usage?.cacheWrite ?? 0);
    state.cached = d.usage?.cacheRead ?? 0;
  }
  if (event.type === "tool_start" && d.toolName === "observe") state.observes++;
  store.index(id, { state });
  const start = index.store("run-starts").meta(id);
  if (start) index.store("run-calls").index(id, { epoch: start.epoch, number: start.number, position: start.position,
    duration: state.duration, headers: state.transport === "sse" ? state.headers : null,
    wsWait: state.transport === "websocket" ? state.wsWait : null,
    completed: state.duration !== null && !["error", "aborted"].includes(state.status),
    input: state.input, cached: state.cached, observes: state.observes });
}

async function projectSpanEvent(index: LogIndex, event: Event, position: number, pending: Map<string, TelemetryState>) {
  if (!event.trace.traceId || !event.trace.spanId) return;
  const key = spanKey(event), epoch = epochOf(event), states = index.store("run-span-state");
  const previous = states.meta(key)?.recipe as TelemetryRecipe | undefined;
  const trace = { ...previous?.trace, ...event.trace }, facts = telemetryFactKeys(event);
  if (previous && !facts.starts.length && !facts.ends.length && !facts.native && JSON.stringify(trace) === JSON.stringify(previous.trace)) return;
  let state = pending.get(key);
  // A finished span normally needs no more work. Truly late facts restore only
  // its explicit lifecycle endpoints, never the complete relation group.
  if (!state && previous) {
    state = { trace: previous.trace, starts: {}, ends: {} };
    const positions = new Set([...Object.values(previous.starts), ...Object.values(previous.ends),
      ...(previous.nativeEnd ? [previous.nativeEnd] : [])]);
    for (const sourcePosition of [...positions].sort((a, b) => a - b)) {
      const source = await index.readEvent(sourcePosition);
      if (!source) throw new Error("生命周期来源事件不存在");
      state = advanceTelemetry(state, source) ?? state;
    }
    state.trace = previous.trace;
  }
  state = advanceTelemetry(state, event);
  if (!state) return;
  const recipe: TelemetryRecipe = { trace, starts: { ...previous?.starts }, ends: { ...previous?.ends },
    ...(previous?.nativeEnd ? { nativeEnd: previous.nativeEnd } : {}) };
  for (const name of facts.starts) recipe.starts[name] = position;
  for (const name of facts.ends) recipe.ends[name] ??= position;
  if (facts.native) recipe.nativeEnd = position;
  states.index(key, { recipe });
  const unfinished = Object.keys(recipe.starts).some(name => !recipe.ends[name])
    || Object.keys(recipe.ends).some(name => !recipe.starts[name]);
  if (unfinished) pending.set(key, state); else pending.delete(key);
  const telemetry = telemetryFromState(state);
  for (const item of telemetry.spans) index.store("run-spans").index(identity(epoch, item.id), {
    epoch, trace: item.traceId, span: item.spanId, parent: item.parentSpanId ?? null, model: item.modelCallId ?? null,
    kind: item.kind, outcome: item.outcome, duration: item.durationMs, position: item.startSeq, telemetryId: item.id,
  });
  for (const loop of telemetry.shiori.nativeLoops)
    await index.store("run-loops").put(key, loop, { epoch, position: state.nativeEnd!.seq });
}

type ObservationRecipe = Meta & { positions: number[]; requestPosition?: number; encoded?: number | null };
async function hydrateObservation(index: LogIndex, recipe: ObservationRecipe, signal?: AbortSignal) {
  let previous: { observation: Observation; archive: ArchivedObservation } | undefined;
  const request = recipe.requestPosition ? await index.readEvent(recipe.requestPosition) : undefined;
  for (const position of [...new Set(recipe.positions)].sort((a, b) => a - b)) {
    signal?.throwIfAborted();
    const event = await index.readEvent(position);
    if (!event) continue;
    const archived = eventObservations(event).find(item => item.id === recipe.observationId);
    const item = aggregate([...(request ? [request] : []), event]).observations.find(item => item.id === recipe.observationId);
    if (!item || !archived) continue;
    const observation = previous ? { ...previous.observation,
      ...(item.hook || item.perception ? { hook: item.hook, perception: item.perception, text: item.text, origin: item.origin } : {}),
      ...(item.mediaStorage !== "unrecorded" ? { mediaStorage: item.mediaStorage, timeline: item.timeline } : {}) } : item;
    previous = { observation, archive: { ...previous?.archive, ...archived } };
  }
  if (previous && recipe.encoded !== undefined) previous.observation.encodeMs = recipe.encoded ?? undefined;
  return previous;
}
async function hydrateNotice(index: LogIndex, position: number, signal?: AbortSignal, supplied?: Event) {
  signal?.throwIfAborted();
  const event = supplied ?? await index.readEvent(position);
  if (!event) return;
  let context: Event[] = [];
  const epoch = epochOf(event);
  if (event.type.startsWith("compaction_http_")) context = await relatedEvents(index, { epoch, beforePosition: position,
    types: ["auto_compaction_start", "auto_compaction_end", "compaction_http_start"] }, signal);
  if (event.type === "observation_error" && event.trace.traceId && event.trace.spanId)
    context = await relatedEvents(index, { epoch, types: ["execution_error"],
      traceId: event.trace.traceId, spanId: event.trace.spanId }, signal);
  signal?.throwIfAborted();
  return aggregate([...context, event]).notices.find(item => item.seq === event.seq);
}
async function projectObservation(index: LogIndex, event: Event, position: number) {
  const epoch = epochOf(event), observations = index.store("run-observations");
  for (const item of eventObservations(event)) {
    const key = identity(epoch, item.id), previous = observations.meta(key);
    const request = (event.trace.operationId || event.trace.spanId) ? index.store("run-requests").meta(identity(epoch, event.trace.operationId ?? event.trace.spanId)) : undefined;
    // A recipe keeps the first capture plus latest presentation/storage revisions.
    // No image, perception text or repeated JSON body is persisted here.
    const first = previous?.first ?? position;
    const presentation = item.hook || item.perception ? position : previous?.presentation;
    const storage = item.path || item.timeline ? position : previous?.storage;
    observations.index(key, { epoch, observationId: item.id, position, first, presentation, storage,
      positions: [...new Set([first, presentation, storage].filter((value): value is number => value !== undefined))],
      requestPosition: request?.position ?? previous?.requestPosition,
      encoded: index.store("run-encodings").meta(key)?.duration ?? previous?.encoded });
  }
  if (event.type === "observation_media") {
    const key = identity(epoch, event.data.observationId), previous = observations.meta(key);
    index.store("run-encodings").index(key, { duration: event.data.durationMs ?? null });
    if (previous) observations.index(key, { ...previous, encoded: event.data.durationMs });
  }
}
export type ProjectionBatch = { maxEvents?: number; signal?: AbortSignal; ingest?: boolean };
export function runProgress(index: LogIndex) {
  const position = Number(index.meta("run_position") ?? 0);
  return { position, total: index.eventRevision, complete: position >= index.eventRevision };
}

export type ProjectionRow = { event: Event; position: number };
/** Consume each source fact once. Stores retain small resumable state and source recipes. */
export async function createRunReducer(index: LogIndex, options: { cold?: boolean; signal?: AbortSignal } = {}) {
  await initialise(index);
  let position = Number(index.meta("run_position") ?? 0);
  const states = new Map<string, CycleState>();
  const pendingSpans = new Map<string, TelemetryState>();
  return {
    async feed(row: ProjectionRow) {
      options.signal?.throwIfAborted();
      if (row.position <= position) return;
      const event = row.event, epoch = epochOf(event), d = event.data;
      position = row.position;
      let state = states.get(epoch);
      if (!state) { state = await index.store("run-states").get<CycleState>(epoch) ?? blankState(); states.set(epoch, state); }
      const increment = (name: string) => state!.counts[name] = (state!.counts[name] ?? 0) + 1;
      increment(`source:${event.source?.component ?? "unlabelled"}`);
      if (isCompletedControllerAction(event)) increment("actions");
      if (event.type === "auto_compaction_end") increment("compactions");
      if (event.type === "model_start") {
        index.store("run-starts").index(event.trace.modelCallId, { epoch, position, number: ++state.callCount,
          contextPosition: state.contextPosition });
      }
      if (event.type === "context") {
        state.contextPosition = position;
        index.store("run-contexts").index(String(position), { epoch, position });
      }
      const execution = observationExecution(event);
      if (execution?.result) index.store("run-inputs").index(identity(epoch, execution.result.id), { position });
      if ((event.type === "observation_start" || event.type === "command" || event.type === "capability_start" && event.data.action === "call") && (event.trace.operationId || event.trace.spanId))
        index.store("run-requests").index(identity(epoch, event.trace.operationId ?? event.trace.spanId), { position });
      if (event.type === "control") {
        state.lastControl = { ...d, at: event.at };
        if (d.mode === "auto") {
          state.autoStarted = Date.parse(event.at);
          if (event.trace.epoch) await index.store("run-cycles").put(epoch, { epoch, startedAt: event.at }, { position, epoch });
        } else if (state.autoStarted !== undefined) {
          state.elapsedMs += Date.parse(event.at) - state.autoStarted;
          delete state.autoStarted;
        }
      }
      if (event.type === "auto_compaction_start") state.compaction = { startedAt: event.at, reason: String(d.reason ?? d.action ?? "") };
      if (event.type === "auto_compaction_end") state.compaction = null;
      advanceLivePhase(state.phase, [event]);
      await projectObservation(index, event, position);
      const errorKey = spanKey(event), errorStore = index.store("run-error-spans"), priorError = errorStore.meta(errorKey);
      if (event.type === "execution_error" && event.trace.traceId && event.trace.spanId) {
        if (priorError?.notice) await index.store("run-notices").delete(String(priorError.notice));
        errorStore.index(errorKey, { execution: true });
      }
      if (event.type.includes("error") || event.type.includes("compaction") || event.type === "disconnected" || event.type === "perception_observe_end" || event.type === "action_end") {
        const notice = event.type === "observation_error" && priorError?.execution ? undefined : aggregate([event]).notices[0];
        if (notice) {
          index.store("run-notices").index(String(position), { epoch, position, failed: !!notice.failed,
            type: event.type, trace: event.trace.traceId, span: event.trace.spanId });
          if (event.type === "observation_error" && event.trace.traceId && event.trace.spanId)
            errorStore.index(errorKey, { notice: position });
        }
      }
      projectCallEvent(index, event);
      await projectSpanEvent(index, event, position, pendingSpans);
    },
    async finish() {
      // Commit the completed prefix even when the caller cancelled before its next event.
      for (const [epoch, state] of states) await index.store("run-states").put(epoch, state);
      index.setMeta("run_position", position);
    },
  };
}

async function projectRun(index: LogIndex, options: ProjectionBatch = {}) {
  if (options.ingest !== false) await index.refreshEvents({ signal: options.signal });
  await index.exclusive(async () => {
    const reducer = await createRunReducer(index, options);
    let position = Number(index.meta("run_position") ?? 0), consumed = 0;
    while (position < index.eventRevision && consumed < (options.maxEvents ?? Infinity)) {
      options.signal?.throwIfAborted();
      const batch = await index.queryEvents({ afterPosition: position, limit: Math.min(500, (options.maxEvents ?? Infinity) - consumed), signal: options.signal });
      if (!batch.length) break;
      try { for (const row of batch) await reducer.feed(row); }
      finally { await reducer.finish(); }
      position = batch.at(-1)!.position;
      consumed += batch.length;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

const refreshes = new WeakMap<LogIndex, { promise: Promise<void>; signal?: AbortSignal }>();
/** Concurrent overview and media readers share one incremental projection. */
export function refreshRunProjection(index: LogIndex, options: ProjectionBatch = {}) {
  let pending = refreshes.get(index);
  if (!pending || pending.signal?.aborted) {
    const next = { promise: undefined! as Promise<void>, signal: options.signal };
    next.promise = projectRun(index, options).finally(() => { if (refreshes.get(index) === next) refreshes.delete(index); });
    refreshes.set(index, next); pending = next;
  }
  return pending.promise;
}

export interface RunPage { beforeCall?: number; call?: string; image?: string }
export async function selectIndexedCycle(index: LogIndex, manifest: Manifest, epoch?: string) {
  const cycles = await Promise.all([...rows(index, "run-cycles")].sort((a, b) => a.position - b.position)
    .map(entry => index.store("run-cycles").get<{ epoch: string; startedAt: string }>(entry.id)));
  const complete = cycles.filter((cycle): cycle is NonNullable<typeof cycle> => !!cycle);
  if (epoch !== undefined && !complete.some(cycle => cycle.epoch === epoch)) throw new Error("所选周期不属于当前运行");
  return { cycles: complete, selectedEpoch: epoch ?? complete.at(-1)?.epoch ?? null,
    wholeRun: manifest.kind === "benchmark" && !complete.length && !epoch };
}

type SpanMeasurements = { started: number; outcomes: SpanStats["outcomes"]; durations: number[] };
const blankMeasurements = (): SpanMeasurements => ({ started: 0, durations: [],
  outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 } });
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return {
    median: values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null,
    p95: values.length ? values[Math.ceil(values.length * .95) - 1] : null,
  };
}
function measurements(value: SpanMeasurements): SpanStats {
  return { started: value.started, outcomes: value.outcomes, durationMs: distribution(value.durations) };
}

export async function readRunProjection(index: LogIndex, epoch: string | null, page: RunPage = {}, wholeRun = false, now = Date.now(), signal?: AbortSignal) {
  signal?.throwIfAborted();
  const scoped = (entry: Meta) => wholeRun || entry.epoch === (epoch ?? "");
  const scope = wholeRun ? {} : { where: { epoch: epoch ?? "" } };
  const callStore = index.store("run-calls");
  let totalCalls = 0, completed = 0, input = 0, cached = 0, explicitObserves = 0;
  let firstCompleted: Meta | undefined;
  let firstCallPosition = Infinity;
  const times: Record<"duration" | "headers" | "wsWait", number[]> = { duration: [], headers: [], wsWait: [] };
  function* callPage() {
    for (const entry of callStore.entries(scope)) {
      if (!scoped(entry)) continue;
      totalCalls++;
      firstCallPosition = Math.min(firstCallPosition, Number(entry.position));
      explicitObserves += entry.observes ?? 0;
      if (entry.completed) {
        completed++;
        input += entry.input ?? 0; cached += entry.cached ?? 0;
        if (!firstCompleted || entry.position < firstCompleted.position) firstCompleted = entry;
        for (const field of ["duration", "headers", "wsWait"] as const)
          if (finite(entry[field])) times[field].push(entry[field]);
      }
      if (page.beforeCall === undefined || entry.number < page.beforeCall) yield entry;
    }
  }
  const visible = newest(callPage(), PAGE_SIZE);
  const hydrated = await readPage(visible, item => hydrateCall(index, item.id, signal), signal);
  const calls = hydrated.flatMap(value => value ? [value.call] : []);
  const selectedMeta = page.call ? callStore.meta(page.call) : undefined;
  const selectedStored = selectedMeta && scoped(selectedMeta) ? (await hydrateCall(index, selectedMeta.id, signal))?.call : calls.at(-1);
  const selected = selectedStored ? { ...selectedStored, tools: await readPage(selectedStored.tools, async tool =>
    tool.argsRef ? { ...tool, args: await readArtifact(index.path, tool.argsRef,
      { media: "reference", workspace: index.archiveWorkspace }) as Record<string, any> } : tool, signal) } : undefined;
  const pageCallIds = new Set([...calls, ...(selected ? [selected] : [])].map(call => call.id));
  const ids = new Set([...calls, ...(selected ? [selected] : [])].flatMap(call => [...call.inputObservations, ...call.observations]));
  if (page.image) ids.add(page.image);
  const observationStore = index.store("run-observations");
  const observations: Observation[] = [];
  // Epoch-scoped IDs are primary keys, so an old image need not walk the capture history.
  if (!wholeRun) {
    for (const id of ids) {
      const recipe = observationStore.meta(identity(epoch ?? "", id)) as ObservationRecipe | undefined;
      const value = recipe ? await hydrateObservation(index, recipe, signal) : undefined;
      if (value) observations.push(value.observation);
    }
  } else {
    for (const entry of observationStore.entries()) if (ids.has(String(entry.observationId))) {
      const value = await hydrateObservation(index, entry as ObservationRecipe, signal);
      if (value && !observations.some(item => item.id === value.observation.id)) observations.push(value.observation);
    }
  }
  observations.sort((a, b) => a.at.localeCompare(b.at));
  const spanStore = index.store("run-spans");
  const statistics = new Map<string, SpanMeasurements>();
  const related = new Set<string>();
  const spanId = (entry: Meta) => identity(entry.trace, entry.span);
  function* independentSpans() {
    for (const entry of spanStore.entries(scope)) {
      if (!scoped(entry)) continue;
      const value = statistics.get(entry.kind) ?? blankMeasurements();
      statistics.set(entry.kind, value);
      value.started++;
      const outcome = entry.outcome as keyof SpanStats["outcomes"];
      if (outcome in value.outcomes) value.outcomes[outcome]++;
      else value.outcomes.unknown++;
      if (finite(entry.duration)) value.durations.push(entry.duration);
      if (pageCallIds.has(entry.model)) related.add(spanId(entry));
      if (!entry.model && ["compaction", "compaction-http"].includes(entry.kind)) yield entry;
    }
  }
  const independent = new Set(newest(independentSpans(), 100).map(entry => entry.id));
  // Keep only the visible calls' family. A trace can contain unrelated continuous
  // sampling; retaining the entire trace would make pagination unbounded again.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of spanStore.entries(scope)) {
      if (!scoped(entry) || !entry.parent || !related.has(identity(entry.trace, entry.parent)) || related.has(spanId(entry))) continue;
      related.add(spanId(entry)); changed = true;
    }
  }
  const family = new Set(related);
  changed = true;
  while (changed) {
    changed = false;
    for (const entry of spanStore.entries(scope)) {
      if (!scoped(entry) || !family.has(spanId(entry)) || !entry.parent || family.has(identity(entry.trace, entry.parent))) continue;
      family.add(identity(entry.trace, entry.parent)); changed = true;
    }
  }
  const selectedSpans: Meta[] = [];
  for (const entry of spanStore.entries(scope)) if (scoped(entry) && (family.has(spanId(entry)) || independent.has(entry.id))) selectedSpans.push(entry);
  const spans = (await readPage(selectedSpans.sort((a, b) => a.position - b.position),
    async entry => projectTelemetry(await relatedEvents(index, { epoch: entry.epoch, traceId: entry.trace, spanId: entry.span }, signal)).spans.find(item => item.id === entry.telemetryId), signal)).filter((span): span is TraceSpan => !!span);
  const stats = (kind: string) => measurements(statistics.get(kind) ?? blankMeasurements());
  const states: CycleState[] = [];
  for (const item of rows(index, "run-states")) if (wholeRun || item.id === (epoch ?? "")) {
    const value = await index.store("run-states").get<CycleState>(item.id);
    if (value) states.push(value);
  }
  const state = states.at(-1) ?? blankState();
  const counts: Record<string, number> = {};
  for (const value of states) for (const [name, count] of Object.entries(value.counts)) counts[name] = (counts[name] ?? 0) + count;
  const recent = async <T>(name: string) => {
    const result: T[] = [];
    for (const entry of newest(rows(index, name), 100, scoped)) {
      signal?.throwIfAborted();
      const value = name === "run-notices" ? await hydrateNotice(index, Number(entry.position), signal) as T | undefined
        : await index.store(name).get<T>(entry.id);
      if (value !== undefined) result.push(value);
    }
    return result;
  };
  const cycleEntries = [...rows(index, "run-cycles")].sort((a, b) => a.position - b.position);
  const cycleIndex = cycleEntries.findIndex(item => item.id === epoch);
  const nextCycle = cycleIndex < 0 ? undefined : cycleEntries[cycleIndex + 1];
  const perceptionEvent = (await index.queryEvents({ types: ["perception_status", "perception_observe_end"],
    beforePosition: nextCycle?.position, reverse: true, limit: 1, signal }))[0]?.event;
  const firstVisible = visible[0], hasMore = !!firstVisible && firstCallPosition < firstVisible.position;
  let errors = 0;
  for (const entry of rows(index, "run-notices")) if (scoped(entry) && entry.failed) errors++;
  const duration = distribution(times.duration), headers = distribution(times.headers), wsWait = distribution(times.wsWait);
  return {
    calls, selectedCall: selected,
    paging: { totalCalls, beforeCall: hasMore ? firstVisible.number as number : null,
      hasMore, firstIndex: calls[0]?.index ?? 0, lastIndex: calls.at(-1)?.index ?? 0 },
    observations, notices: await recent<RunData["notices"][number]>("run-notices"),
    skills: hydrated.flatMap(value => value?.skills ?? []).slice(-100),
    perception: perceptionEvent?.type === "perception_status" ? perceptionEvent.data as any : perceptionEvent?.data.status ?? null,
    lastControl: state.lastControl,
    activeCompaction: state.compaction ? { ...state.compaction, elapsedMs: Math.max(0, now - Date.parse(state.compaction.startedAt)) } : null,
    phase: livePhaseValue(state.phase, now),
    telemetry: { sources: Object.entries(counts).filter(([name]) => name.startsWith("source:"))
      .map(([name, count]) => ({ component: name.slice(7), count })).sort((a, b) => b.count - a.count || a.component.localeCompare(b.component)),
      spans, shiori: { stats: stats("shiori"), nativeLoops: await recent<NativeLoop>("run-loops") },
      capabilities: { stats: stats("capability"), python: stats("python"),
        localPython: stats("python-local"), discovery: stats("discovery") },
      devices: stats("device"), perception: stats("perception"),
    },
    summary: { completed, actions: counts.actions ?? 0, explicitObserves, errors,
      compactions: counts.compactions ?? 0, medianMs: duration.median, p95Ms: duration.p95,
      medianHeadersMs: headers.median, medianHttpHeadersMs: headers.median,
      medianWsWaitMs: wsWait.median, cacheHit: input ? cached / input : null,
      warmCacheHit: input - (firstCompleted?.input ?? 0) ? (cached - (firstCompleted?.cached ?? 0)) / (input - (firstCompleted?.input ?? 0)) : null,
      elapsedSeconds: states.reduce((total, value) => total + value.elapsedMs + (value.autoStarted !== undefined ? Math.max(0, now - value.autoStarted) : 0), 0) / 1000,
    },
  };
}

export async function indexedObservation(index: LogIndex, id: string, signal?: AbortSignal): Promise<ArchivedObservation | undefined> {
  signal?.throwIfAborted();
  let position = 0, value: ArchivedObservation | undefined, epoch: string | undefined;
  for (;;) {
    const refs = await index.queryEventRefs({ observationId: id, afterPosition: position, limit: 500, signal });
    if (!refs.length) return value;
    for (const ref of refs) {
      const event = (await index.readEvent(ref))!;
      const observation = eventObservations(event).find(item => item.id === id);
      if (observation) {
        const nextEpoch = epochOf(event);
        value = { ...(nextEpoch === epoch ? value : undefined), ...observation };
        epoch = nextEpoch;
      }
      position = ref.position;
    }
  }
}

/** Exact context/result identities authorize model-input history; no nearest-frame inference. */
export async function hasTimelineReference(index: LogIndex, recordId: string, sequence: number,
  source: { call?: string; observation?: string }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let perception;
  if (source.observation) perception = (await indexedObservation(index, source.observation, signal))?.perception;
  else if (source.call) {
    const start = (await index.queryEventRefs({ model: source.call, types: ["model_start"], limit: 1, signal }))[0];
    if (start) {
      const contextRef = (await index.queryEventRefs({ epoch: start.epoch, types: ["context"], beforePosition: start.position,
        reverse: true, limit: 1, signal }))[0];
      const context = contextRef ? await index.readEvent(contextRef) : undefined;
      const inputs: Event[] = [];
      for (const resultId of context?.data.executions ?? []) {
        const ref = (await index.queryEventRefs({ resultId, epoch: start.epoch, beforePosition: start.position,
          reverse: true, limit: 1, signal }))[0];
        if (ref) inputs.push((await index.readEvent(ref))!);
      }
      perception = aggregate([...inputs, ...(context ? [context] : []), (await index.readEvent(start))!]).calls[0]?.perception;
    }
  }
  return [perception?.snapshot, ...(perception?.records?.map(record => record.snapshot) ?? [])]
    .some(snapshot => snapshot?.timeline?.recordId === recordId && snapshot.timeline.sequence === sequence);
}
