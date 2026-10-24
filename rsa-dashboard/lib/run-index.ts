import type { LogIndex, RecordPointer } from "./log-index";
import { aggregate, isCompletedControllerAction } from "./aggregate";
import { projectTelemetry, p95 } from "./telemetry";
import { eventObservations, observationExecution, type ArchivedObservation } from "./observation-events";
import { advanceLivePhase, emptyLivePhase, livePhaseValue, type LivePhaseState } from "./live-phase";
import type { Call, Event, Manifest, NativeLoop, Observation, RunData, SpanStats, TraceSpan } from "./types";

const VERSION = "files-2";
const PAGE_SIZE = 100;
type Meta = Record<string, any> & { id: string };
type CycleState = { phase: LivePhaseState; lastControl: Record<string, any> | null; autoStarted?: number;
  elapsedMs: number; callCount: number; counts: Record<string, number>; compaction: { startedAt: string; reason: string } | null };
const blankState = (): CycleState => ({ phase: emptyLivePhase(), lastControl: null, elapsedMs: 0, callCount: 0, counts: {}, compaction: null });
const epochOf = (event: Event) => event.trace?.epoch ?? "";
const identity = (...parts: unknown[]) => JSON.stringify(parts);
const spanKey = (event: Event) => identity(epochOf(event), event.trace.traceId, event.trace.spanId);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stores = ["run-calls", "run-starts", "run-observations", "run-spans", "run-loops", "run-notices", "run-skills",
  "run-states", "run-contexts", "run-inputs", "run-requests", "run-encodings", "run-cycles"];
const rows = (index: LogIndex, name: string): Meta[] => [...index.store(name).entries()];

async function initialise(index: LogIndex) {
  const stamp = `${VERSION}:${index.generation}`;
  if (index.meta("run_projection") === stamp) return;
  for (const name of stores)
    for (const entry of index.store(name).entries()) await index.store(name).delete(entry.id);
  index.setMeta("run_projection", stamp);
  index.setMeta("run_position", 0);
}

/** Read only explicitly related event bodies; the full history remains on disk. */
async function relatedEvents(index: LogIndex, predicate: (entry: Meta) => boolean): Promise<Event[]> {
  const source = index.store("events");
  const matching = [...source.entries()].filter(predicate).sort((a, b) => Number(a.position) - Number(b.position));
  const result: Event[] = [];
  for (const entry of matching) result.push(await source.read<Event>(entry));
  return result;
}

async function projectCall(index: LogIndex, id: string, source: RecordPointer[]) {
  const start = index.store("run-starts").meta(id);
  if (!start) return;
  const events = await Promise.all(source.filter(entry => (entry.epoch ?? "") === start.epoch).map(entry => index.store("events").read<Event>(entry)));
  const contextMeta = rows(index, "run-contexts").filter(item => item.epoch === start.epoch && item.position < start.position)
    .sort((a, b) => b.position - a.position)[0];
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

async function projectSpan(index: LogIndex, key: string, source: RecordPointer[]) {
  const [epoch, trace, span] = JSON.parse(key) as string[];
  const events = await Promise.all(source.map(entry => index.store("events").read<Event>(entry)));
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
        ...(item.hook || item.perception ? { hook: item.hook, perception: item.perception, text: item.text, origin: item.origin } : {}) } : item;
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
    const byModel = new Map<string, RecordPointer[]>(), bySpan = new Map<string, RecordPointer[]>();
    if (position < index.eventRevision) for (const entry of index.store("events").entries()) {
      if (entry.model) { const group = byModel.get(entry.model) ?? []; group.push(entry); byModel.set(entry.model, group); }
      if (entry.traceId && entry.spanId) { const key = identity(entry.epoch ?? "", entry.traceId, entry.spanId);
        const group = bySpan.get(key) ?? []; group.push(entry); bySpan.set(key, group); }
    }
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
          if (event.type.startsWith("compaction_http_")) context = await relatedEvents(index, item => (item.epoch ?? "") === epoch
            && item.position < position && ["auto_compaction_start", "auto_compaction_end", "compaction_http_start"].includes(item.type));
          if (event.type === "observation_error" && event.trace.traceId && event.trace.spanId)
            context = await relatedEvents(index, item => (item.epoch ?? "") === epoch && item.type === "execution_error"
              && item.traceId === event.trace.traceId && item.spanId === event.trace.spanId);
          const notice = aggregate([...context, event]).notices.find(item => item.seq === event.seq);
          if (notice) await index.store("run-notices").put(String(position), notice, { epoch, position, failed: !!notice.failed, type: event.type, trace: event.trace.traceId, span: event.trace.spanId });
        }
      }
      for (const id of models) await projectCall(index, id, byModel.get(id) ?? []);
      for (const id of spans) await projectSpan(index, id, bySpan.get(id) ?? []);
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
  const cycles = await Promise.all(rows(index, "run-cycles").sort((a, b) => a.position - b.position)
    .map(entry => index.store("run-cycles").get<{ epoch: string; startedAt: string }>(entry.id)));
  const complete = cycles.filter((cycle): cycle is NonNullable<typeof cycle> => !!cycle);
  if (epoch !== undefined && !complete.some(cycle => cycle.epoch === epoch)) throw new Error("所选周期不属于当前运行");
  return { cycles: complete, selectedEpoch: epoch ?? complete.at(-1)?.epoch ?? null,
    wholeRun: manifest.kind === "benchmark" && !complete.length && !epoch };
}

function spanStats(entries: Meta[], kind: string): SpanStats {
  const items = entries.filter(item => item.kind === kind);
  const outcomes: SpanStats["outcomes"] = { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 };
  for (const item of items) outcomes[item.outcome as keyof typeof outcomes]++;
  const durations = items.flatMap(item => finite(item.duration) ? [item.duration] : []);
  return { started: items.length, outcomes, durationMs: { median: median(durations), p95: p95(durations) } };
}

export async function readRunProjection(index: LogIndex, epoch: string | null, page: RunPage = {}, wholeRun = false, now = Date.now()) {
  const scoped = (entry: Meta) => wholeRun || entry.epoch === (epoch ?? "");
  const callStore = index.store("run-calls");
  const callEntries = rows(index, "run-calls").filter(scoped).sort((a, b) => a.position - b.position);
  const visible = callEntries.filter(item => page.beforeCall === undefined || item.number < page.beforeCall).slice(-PAGE_SIZE);
  const calls = (await Promise.all(visible.map(item => callStore.get<Call>(item.id)))).filter((call): call is Call => !!call);
  const selected = page.call && callEntries.some(item => item.id === page.call) ? await callStore.get<Call>(page.call) : undefined;
  const pageCallIds = new Set([...calls, ...(selected ? [selected] : [])].map(call => call.id));
  const ids = new Set([...calls, ...(selected ? [selected] : [])].flatMap(call => [...call.inputObservations, ...call.observations]));
  if (page.image) ids.add(page.image);
  const observationStore = index.store("run-observations");
  const observations: Observation[] = [];
  for (const entry of observationStore.entries()) if (scoped(entry) && ids.has(String(entry.observationId))) {
    const value = await observationStore.get<{ observation: Observation }>(entry.id);
    if (value && !observations.some(item => item.id === value.observation.id)) observations.push(value.observation);
  }
  observations.sort((a, b) => a.at.localeCompare(b.at));
  const allSpans = rows(index, "run-spans").filter(scoped);
  const family = new Set<string>();
  const related = new Set<string>();
  const spanId = (entry: Meta) => identity(entry.trace, entry.span);
  for (const entry of allSpans) if (pageCallIds.has(entry.model)) related.add(spanId(entry));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of allSpans) if (entry.parent && related.has(identity(entry.trace, entry.parent)) && !related.has(spanId(entry))) {
      related.add(spanId(entry)); changed = true;
    }
  }
  for (const id of related) family.add(id);
  changed = true;
  while (changed) {
    changed = false;
    for (const entry of allSpans) if (family.has(spanId(entry)) && entry.parent && !family.has(identity(entry.trace, entry.parent))) {
      family.add(identity(entry.trace, entry.parent)); changed = true;
    }
  }
  const independent = allSpans.filter(entry => !entry.model && ["compaction", "compaction-http"].includes(entry.kind))
    .sort((a, b) => b.position - a.position).slice(0, 100);
  const selectedSpans = allSpans.filter(entry => family.has(spanId(entry)) || independent.includes(entry));
  const spans = (await Promise.all(selectedSpans.sort((a, b) => a.position - b.position)
    .map(entry => index.store("run-spans").get<TraceSpan>(entry.id)))).filter((span): span is TraceSpan => !!span);
  const completed = callEntries.filter(item => item.completed);
  const input = completed.reduce((total, item) => total + item.input, 0), cached = completed.reduce((total, item) => total + item.cached, 0);
  const states = (await Promise.all(rows(index, "run-states").filter(item => wholeRun || item.id === (epoch ?? ""))
    .map(item => index.store("run-states").get<CycleState>(item.id)))).filter((state): state is CycleState => !!state);
  const state = states.at(-1) ?? blankState();
  const counts: Record<string, number> = {};
  for (const value of states) for (const [name, count] of Object.entries(value.counts)) counts[name] = (counts[name] ?? 0) + count;
  const performanceValues = (field: string) => completed.flatMap(item => finite(item[field]) ? [item[field] as number] : []);
  const recent = async <T>(name: string) => {
    const entries = rows(index, name).filter(scoped).sort((a, b) => a.position - b.position).slice(-100);
    const result: T[] = [];
    for (const entry of entries) { const value = await index.store(name).get<T>(entry.id); if (value !== undefined) result.push(value); }
    return result;
  };
  const cycleEntries = rows(index, "run-cycles").sort((a, b) => a.position - b.position);
  const cycleIndex = cycleEntries.findIndex(item => item.id === epoch);
  const nextCycle = cycleIndex < 0 ? undefined : cycleEntries[cycleIndex + 1];
  const perceptionMeta = [...index.store("events").entries()].filter(item => ["perception_status", "perception_observe_end"].includes(String(item.type))
    && (!nextCycle || Number(item.position) < nextCycle.position)).at(-1);
  const perceptionEvent = perceptionMeta ? await index.store("events").read<Event>(perceptionMeta) : undefined;
  const firstVisible = visible[0], hasMore = !!firstVisible && callEntries.some(item => item.position < firstVisible.position);
  return {
    calls, selectedCall: selected,
    paging: { totalCalls: callEntries.length, beforeCall: hasMore ? firstVisible.number as number : null,
      hasMore, firstIndex: calls[0]?.index ?? 0, lastIndex: calls.at(-1)?.index ?? 0 },
    observations, notices: await recent<RunData["notices"][number]>("run-notices"),
    skills: (await recent<RunData["skills"]>("run-skills")).flat().slice(-100),
    perception: perceptionEvent?.type === "perception_status" ? perceptionEvent.data as any : perceptionEvent?.data.status ?? null,
    lastControl: state.lastControl,
    activeCompaction: state.compaction ? { ...state.compaction, elapsedMs: Math.max(0, now - Date.parse(state.compaction.startedAt)) } : null,
    phase: livePhaseValue(state.phase, now),
    telemetry: { sources: Object.entries(counts).filter(([name]) => name.startsWith("source:"))
      .map(([name, count]) => ({ component: name.slice(7), count })).sort((a, b) => b.count - a.count || a.component.localeCompare(b.component)),
      spans, shiori: { stats: spanStats(allSpans, "shiori"), nativeLoops: await recent<NativeLoop>("run-loops") },
      capabilities: { stats: spanStats(allSpans, "capability"), python: spanStats(allSpans, "python"),
        localPython: spanStats(allSpans, "python-local"), discovery: spanStats(allSpans, "discovery") },
      devices: spanStats(allSpans, "device"), perception: spanStats(allSpans, "perception"),
    },
    summary: { completed: completed.length, actions: counts.actions ?? 0,
      explicitObserves: callEntries.reduce((total, item) => total + item.observes, 0),
      errors: rows(index, "run-notices").filter(item => scoped(item) && item.failed).length,
      compactions: counts.compactions ?? 0, medianMs: median(performanceValues("duration")), p95Ms: p95(performanceValues("duration")),
      medianHeadersMs: median(performanceValues("headers")), medianHttpHeadersMs: median(performanceValues("headers")),
      medianWsWaitMs: median(performanceValues("wsWait")), cacheHit: input ? cached / input : null,
      warmCacheHit: input - (completed[0]?.input ?? 0) ? (cached - (completed[0]?.cached ?? 0)) / (input - (completed[0]?.input ?? 0)) : null,
      elapsedSeconds: states.reduce((total, value) => total + value.elapsedMs + (value.autoStarted !== undefined ? Math.max(0, now - value.autoStarted) : 0), 0) / 1000,
    },
  };
}

export async function indexedObservation(index: LogIndex, id: string): Promise<ArchivedObservation | undefined> {
  await refreshRunProjection(index);
  const metadata = rows(index, "run-observations").filter(entry => entry.observationId === id).sort((a, b) => b.position - a.position)[0];
  return metadata ? (await index.store("run-observations").get<{ archive: ArchivedObservation }>(metadata.id))?.archive : undefined;
}
