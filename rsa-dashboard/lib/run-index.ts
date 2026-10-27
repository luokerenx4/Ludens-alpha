import type { LogIndex, RecordPointer } from "./log-index";
import { aggregate, isCompletedControllerAction } from "./aggregate";
import { projectTelemetry } from "./telemetry";
import { eventObservations, observationExecution, type ArchivedObservation } from "./observation-events";
import { advanceLivePhase, emptyLivePhase, livePhaseValue, type LivePhaseState } from "./live-phase";
import type { Call, Event, Manifest, NativeLoop, Observation, RunData, SpanStats, TraceSpan } from "./types";

const VERSION = "files-3";
const PAGE_SIZE = 100;
type Meta = RecordPointer;
type CycleState = { phase: LivePhaseState; lastControl: Record<string, any> | null; autoStarted?: number;
  elapsedMs: number; callCount: number; counts: Record<string, number>; compaction: { startedAt: string; reason: string } | null };
const blankState = (): CycleState => ({ phase: emptyLivePhase(), lastControl: null, elapsedMs: 0, callCount: 0, counts: {}, compaction: null });
const epochOf = (event: Event) => event.trace?.epoch ?? "";
const identity = (...parts: unknown[]) => JSON.stringify(parts);
const spanKey = (event: Event) => identity(epochOf(event), event.trace.traceId, event.trace.spanId);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stores = ["run-calls", "run-starts", "run-observations", "run-spans", "run-loops", "run-notices", "run-skills",
  "run-states", "run-contexts", "run-inputs", "run-requests", "run-encodings", "run-cycles"];
const rows = (index: LogIndex, name: string) => index.store(name).entries();

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
  for (const name of stores)
    for (const entry of index.store(name).entries()) await index.store(name).delete(entry.id);
  index.setMeta("run_projection", stamp);
  index.setMeta("run_position", 0);
}

/** Disk relationships select a model/span before its event bodies are loaded. */
type EventFilter = { epoch?: string | null; model?: string; traceId?: string; spanId?: string;
  beforePosition?: number; types?: string[] };
async function relatedEvents(index: LogIndex, filter: EventFilter): Promise<Event[]> {
  const result: Event[] = [];
  let position = 0;
  for (;;) {
    const batch = await index.queryEvents({ ...filter, afterPosition: position, limit: 5000 });
    if (!batch.length) break;
    for (const row of batch) result.push(row.event);
    position = batch.at(-1)!.position;
  }
  return result;
}

async function projectCall(index: LogIndex, id: string) {
  const start = index.store("run-starts").meta(id);
  if (!start) return;
  const events = await relatedEvents(index, { model: id, epoch: start.epoch });
  const contextMeta = newest(rows(index, "run-contexts"), 1,
    item => item.epoch === start.epoch && item.position < start.position)[0];
  const context = contextMeta ? await index.store("run-contexts").get<Event>(contextMeta.id) : undefined;
  const inputs: Event[] = [];
  for (const resultId of context?.data.executions ?? []) {
    const input = await index.store("run-inputs").get<Event>(identity(start.epoch, resultId));
    if (input) inputs.push(input);
  }
  const projected = aggregate([...inputs, ...(context ? [context] : []), ...events]);
  const call = projected.calls.find(item => item.id === id);
  if (!call) return;
  call.index = Number(start.number);
  const completed = call.durationMs !== null && !["error", "aborted"].includes(call.status);
  await index.store("run-calls").put(id, call, { epoch: start.epoch, number: call.index, position: start.position,
    duration: call.durationMs, headers: call.transport === "sse" ? call.headersMs : null,
    wsWait: call.transport === "websocket" ? call.phases.afterDispatchMs ?? null : null,
    completed, input: call.inputTokens, cached: call.cachedTokens, observes: call.tools.filter(tool => tool.name === "observe").length });
  await index.store("run-skills").put(id, projected.skills, { epoch: start.epoch, position: start.position });
}

async function projectSpan(index: LogIndex, key: string) {
  const [epoch, traceId, spanId] = JSON.parse(key) as string[];
  const events = await relatedEvents(index, { epoch, traceId, spanId });
  const telemetry = projectTelemetry(events);
  const target = index.store("run-spans");
  // RPC and asynchronous input lifetimes have separate stable IDs on the same trace.
  for (const item of telemetry.spans) await target.put(identity(epoch, item.id), item, {
    epoch, trace: item.traceId, span: item.spanId, parent: item.parentSpanId ?? null, model: item.modelCallId ?? null,
    kind: item.kind, outcome: item.outcome, duration: item.durationMs, position: item.startSeq,
  });
  for (const loop of telemetry.shiori.nativeLoops)
    await index.store("run-loops").put(key, loop, { epoch, position: events.at(-1)!.seq });
}

async function projectObservation(index: LogIndex, event: Event, position: number) {
  const epoch = epochOf(event), archived = eventObservations(event);
  const observations = index.store("run-observations");
  if (archived.length) {
    const request = event.trace.operationId
      ? await index.store("run-requests").get<Event>(identity(epoch, event.trace.operationId)) : undefined;
    for (const item of aggregate([...(request ? [request] : []), event]).observations) {
      const key = identity(epoch, item.id);
      const previous = await observations.get<{ observation: Observation; archive: ArchivedObservation }>(key);
      const value = previous ? { ...previous.observation,
        ...(item.hook || item.perception ? { hook: item.hook, perception: item.perception, text: item.text,
          origin: item.origin } : {}),
        ...(item.mediaStorage !== "unrecorded" ? { mediaStorage: item.mediaStorage, timeline: item.timeline } : {}) } : item;
      const encoded = await index.store("run-encodings").get<number>(item.id);
      if (encoded !== undefined) value.encodeMs = encoded;
      const source = { ...previous?.archive, ...archived.find(raw => raw.id === item.id) } as ArchivedObservation;
      await observations.put(key, { observation: value, archive: source }, { epoch, observationId: item.id, position });
    }
  }
  if (event.type === "observation_media") {
    await index.store("run-encodings").put(event.data.observationId, event.data.durationMs ?? null);
    const key = identity(epoch, event.data.observationId);
    const previous = await observations.get<{ observation: Observation; archive: ArchivedObservation }>(key);
    const metadata = observations.meta(key);
    if (previous && metadata) await observations.put(key,
      { ...previous, observation: { ...previous.observation, encodeMs: event.data.durationMs } },
      { epoch, observationId: event.data.observationId, position: metadata.position });
  }
}

async function projectRun(index: LogIndex) {
  await index.refreshEvents();
  await index.exclusive(async () => {
    await initialise(index);
    let position = Number(index.meta("run_position") ?? 0);
    while (position < index.eventRevision) {
      const batch = await index.queryEvents({ afterPosition: position, limit: 500 });
      if (!batch.length) break;
      const models = new Set<string>(), spans = new Set<string>(), states = new Map<string, CycleState>();
      const phases = new Map<string, Event[]>();
      for (const row of batch) {
        const event = row.event, epoch = epochOf(event), d = event.data;
        position = row.position;
        if (event.trace.modelCallId) models.add(event.trace.modelCallId);
        if (event.trace.traceId && event.trace.spanId) spans.add(spanKey(event));
        let state = states.get(epoch);
        if (!state) { state = await index.store("run-states").get<CycleState>(epoch) ?? blankState(); states.set(epoch, state); }
        const increment = (name: string) => state!.counts[name] = (state!.counts[name] ?? 0) + 1;
        increment(`source:${event.source?.component ?? "unlabelled"}`);
        if (isCompletedControllerAction(event)) increment("actions");
        if (event.type === "auto_compaction_end") increment("compactions");
        if (event.type === "model_start") {
          await index.store("run-starts").put(event.trace.modelCallId, null, { epoch, position, number: ++state.callCount });
        }
        if (event.type === "context") await index.store("run-contexts").put(String(position), event, { epoch, position });
        const execution = observationExecution(event);
        if (execution?.result) await index.store("run-inputs").put(identity(epoch, execution.result.id), event);
        if (event.type === "observation_start" && event.trace.operationId)
          await index.store("run-requests").put(identity(epoch, event.trace.operationId), event);
        const phaseEvents = phases.get(epoch) ?? []; phaseEvents.push(event); phases.set(epoch, phaseEvents);
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
        await projectObservation(index, event, position);
        if (event.type === "execution_error" && event.trace.traceId && event.trace.spanId) {
          for (const notice of index.store("run-notices").entries())
            if (notice.epoch === epoch && notice.type === "observation_error" && notice.trace === event.trace.traceId && notice.span === event.trace.spanId)
              await index.store("run-notices").delete(notice.id);
        }
        if (event.type.includes("error") || event.type.includes("compaction") || event.type === "disconnected" || event.type === "perception_observe_end" || event.type === "action_end") {
          let context: Event[] = [];
          if (event.type.startsWith("compaction_http_")) context = await relatedEvents(index, { epoch, beforePosition: position,
            types: ["auto_compaction_start", "auto_compaction_end", "compaction_http_start"] });
          if (event.type === "observation_error" && event.trace.traceId && event.trace.spanId)
            context = await relatedEvents(index, { epoch, types: ["execution_error"],
              traceId: event.trace.traceId, spanId: event.trace.spanId });
          const notice = aggregate([...context, event]).notices.find(item => item.seq === event.seq);
          if (notice) await index.store("run-notices").put(String(position), notice, { epoch, position, failed: !!notice.failed, type: event.type, trace: event.trace.traceId, span: event.trace.spanId });
        }
      }
      for (const id of models) await projectCall(index, id);
      for (const id of spans) await projectSpan(index, id);
      for (const [epoch, state] of states) {
        advanceLivePhase(state.phase, phases.get(epoch)!);
        await index.store("run-states").put(epoch, state);
      }
      index.setMeta("run_position", position);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

const refreshes = new WeakMap<LogIndex, Promise<void>>();
/** Concurrent overview and media readers share one incremental projection. */
export function refreshRunProjection(index: LogIndex) {
  let pending = refreshes.get(index);
  if (!pending) {
    pending = projectRun(index).finally(() => refreshes.delete(index));
    refreshes.set(index, pending);
  }
  return pending;
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

export async function readRunProjection(index: LogIndex, epoch: string | null, page: RunPage = {}, wholeRun = false, now = Date.now()) {
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
  const calls = (await Promise.all(visible.map(item => callStore.get<Call>(item.id)))).filter((call): call is Call => !!call);
  const selectedMeta = page.call ? callStore.meta(page.call) : undefined;
  const selected = selectedMeta && scoped(selectedMeta) ? await callStore.get<Call>(selectedMeta.id) : undefined;
  const pageCallIds = new Set([...calls, ...(selected ? [selected] : [])].map(call => call.id));
  const ids = new Set([...calls, ...(selected ? [selected] : [])].flatMap(call => [...call.inputObservations, ...call.observations]));
  if (page.image) ids.add(page.image);
  const observationStore = index.store("run-observations");
  const observations: Observation[] = [];
  // Epoch-scoped IDs are primary keys, so an old image need not walk the capture history.
  if (!wholeRun) {
    for (const id of ids) {
      const value = await observationStore.get<{ observation: Observation }>(identity(epoch ?? "", id));
      if (value) observations.push(value.observation);
    }
  } else {
    for (const entry of observationStore.entries()) if (ids.has(String(entry.observationId))) {
      const value = await observationStore.get<{ observation: Observation }>(entry.id);
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
  const spans = (await Promise.all(selectedSpans.sort((a, b) => a.position - b.position)
    .map(entry => spanStore.get<TraceSpan>(entry.id)))).filter((span): span is TraceSpan => !!span);
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
      const value = await index.store(name).get<T>(entry.id);
      if (value !== undefined) result.push(value);
    }
    return result;
  };
  const cycleEntries = [...rows(index, "run-cycles")].sort((a, b) => a.position - b.position);
  const cycleIndex = cycleEntries.findIndex(item => item.id === epoch);
  const nextCycle = cycleIndex < 0 ? undefined : cycleEntries[cycleIndex + 1];
  const perceptionEvent = (await index.queryEvents({ types: ["perception_status", "perception_observe_end"],
    beforePosition: nextCycle?.position, reverse: true, limit: 1 }))[0]?.event;
  const firstVisible = visible[0], hasMore = !!firstVisible && firstCallPosition < firstVisible.position;
  let errors = 0;
  for (const entry of rows(index, "run-notices")) if (scoped(entry) && entry.failed) errors++;
  const duration = distribution(times.duration), headers = distribution(times.headers), wsWait = distribution(times.wsWait);
  return {
    calls, selectedCall: selected,
    paging: { totalCalls, beforeCall: hasMore ? firstVisible.number as number : null,
      hasMore, firstIndex: calls[0]?.index ?? 0, lastIndex: calls.at(-1)?.index ?? 0 },
    observations, notices: await recent<RunData["notices"][number]>("run-notices"),
    skills: (await recent<RunData["skills"]>("run-skills")).flat().slice(-100),
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

export async function indexedObservation(index: LogIndex, id: string): Promise<ArchivedObservation | undefined> {
  await refreshRunProjection(index);
  const observations = index.store("run-observations");
  let metadata: Meta | undefined;
  // Every projected event contributes an epoch state, including the empty epoch.
  // A few primary-key lookups replace scanning all recorded frames for every image.
  for (const state of index.store("run-states").entries()) {
    const candidate = observations.meta(identity(state.id, id));
    if (candidate && (!metadata || candidate.position > metadata.position)) metadata = candidate;
  }
  return metadata ? (await observations.get<{ archive: ArchivedObservation }>(metadata.id))?.archive : undefined;
}

/** A record detail request must originate from a model input or observation in this run. */
export async function hasTimelineReference(index: LogIndex, recordId: string, sequence: number,
  source: { call?: string; observation?: string }) {
  await refreshRunProjection(index);
  const perception = source.observation
    ? (await indexedObservation(index, source.observation))?.perception
    : source.call ? (await index.store("run-calls").get<Call>(source.call))?.perception : undefined;
  return [perception?.snapshot, ...(perception?.records?.map(record => record.snapshot) ?? [])]
    .some(snapshot => snapshot?.timeline?.recordId === recordId && snapshot.timeline.sequence === sequence);
}
