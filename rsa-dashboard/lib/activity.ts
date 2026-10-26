import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { catalog, hostRequest, loadRun } from "./data";
import { latestGameRun } from "./initial-selection";
import { LogIndex, SourceChanged, type RecordPointer } from "./log-index";
import { activitySearchText } from "../components/activity-feed-model";
import { advanceLivePhase, emptyLivePhase, livePhaseValue, type LivePhaseState } from "./live-phase";
import { eventObservations } from "./observation-events";
import type { Event } from "./types";
import { projectPythonCall } from "./python-activity";

export interface LogBlock {
  id: string;
  kind: "thinking" | "text" | "tool" | "system" | "diagnostic";
  at: string;
  title: string;
  text: string;
  status: "running" | "complete" | "error";
  outcome?: "raised" | "unmet";
  tool?: { intent?: string; args?: unknown; result?: unknown };
  data?: Record<string, unknown>;
  source?: Event["source"];
  trace?: Event["trace"];
  eventId?: string;
  seq?: number;
  updatedAt?: string;
  createdRevision?: number;
  revision?: number;
}

const provenance = (event: Partial<Event>) => ({ source: event.source, trace: event.trace,
  eventId: event.origin?.eventId, seq: event.seq, updatedAt: event.at });

type Json = Record<string, any>;
const unpack = promisify(gunzip);
const callId = (id: string) => id.split("|")[0];
const toolId = (model: string, id: string) => `${model}:tool:${callId(id)}`;
const hidden = new Set(["encrypted_content", "thinkingSignature", "signature", "redactedThinking"]);
function readable(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, (key, item) => {
    if (hidden.has(key)) return undefined;
    if (item && typeof item === "object" && ["image", "input_image", "audio"].includes(item.type))
      return { type: item.type, mimeType: item.mimeType };
    return item;
  }, 2) ?? "";
}
function argumentsText(value: unknown): string {
  if (typeof value !== "string") return readable(value);
  try { return readable(JSON.parse(value)); } catch { return value; }
}
/** Keep source fields structured; incomplete streaming arguments remain text. */
function structuredText(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
function resultText(value: any): string {
  if (Array.isArray(value?.content)) return value.content
    .filter((part: Json) => part.type === "text" && typeof part.text === "string")
    .map((part: Json) => argumentsText(part.text)).join("\n\n");
  return readable(value);
}

/** Project raw provider output only; request input/history is never a new block. */
interface StreamState {
  blocks: [string, LogBlock][]; aliases: [string, string][]; toolNames: [string, string][];
  seen: string[]; responseId: string; line: number; terminal: boolean;
}
const emptyStream = (): StreamState => ({ blocks: [], aliases: [], toolNames: [], seen: [], responseId: "", line: 0, terminal: false });
function advanceStream(text: string, model: string, anchor: Pick<Event, "at" | "atMs"> & Partial<Event>, state: StreamState): LogBlock[] {
  const blocks = new Map(state.blocks);
  const aliases = new Map(state.aliases);
  const toolNames = new Map(state.toolNames);
  const seen = new Set(state.seen);
  let responseId = state.responseId;
  let origin = provenance(anchor);
  const clock = Date.parse(anchor.at) - anchor.atMs;
  const put = (id: string, kind: LogBlock["kind"], at: string, title: string, value: string, done = false, append = false) => {
    const old = blocks.get(id);
    blocks.set(id, { id, kind, at: old?.at ?? at, title, ...origin, updatedAt: at,
      text: append ? (old?.text ?? "") + value : value,
      status: done ? "complete" : "running" });
  };
  const item = (value: Json, at: string, done: boolean, index: number) => {
    const id = value.id ?? `output-${index}`;
    if (value.type === "function_call" || value.type === "custom_tool_call") {
      const key = toolId(model, value.call_id ?? id);
      aliases.set(id, key); toolNames.set(key, value.name ?? "工具");
      put(key, "tool", at, value.name ?? "工具", value.arguments ?? value.input ?? "", done);
    } else if (value.type === "message" && value.role === "assistant") {
      for (const [i, part] of (value.content ?? []).entries()) {
        if (part.type === "output_text" && typeof part.text === "string")
          put(`${model}:text:${id}:${i}`, "text", at, "Assistant", part.text, done);
      }
    } else if (value.type === "reasoning") {
      for (const [i, part] of (value.summary ?? []).entries()) {
        if (typeof part.text === "string") put(`${model}:thinking:${id}:${i}`, "thinking", at, "Thinking", part.text, done);
      }
    }
  };
  const lines = text.split("\n");
  lines.pop();
  for (const line of lines) {
    const lineIndex = state.line++;
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    origin = { ...provenance(anchor), source: row.source ?? anchor.source, trace: { ...anchor.trace, ...row.trace } };
    const wire = row.event ?? row;
    // A WS upload may contain the entire conversation and base64 observations.
    if (wire.event === "response.create" || wire.type === "response.create" || wire.data === "[DONE]") continue;
    const value: Json = typeof wire.data === "string" ? JSON.parse(wire.data) : wire.data ?? wire;
    const type = value.type ?? value.object ?? wire.event ?? "stream";
    if (type === "response.create") continue;
    const at = Number.isFinite(row.atMs) ? new Date(clock + row.atMs).toISOString() : anchor.at;
    if (value.response?.id) responseId = value.response.id;
    if (value.sequence_number !== undefined) {
      const key = `${responseId}:${value.sequence_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      item(value.item, at, type.endsWith(".done"), value.output_index ?? 0);
    } else if (/^response\.(output_text|reasoning_summary_text|reasoning_text)\.(delta|done)$/.test(type)) {
      const thinking = type.includes("reasoning");
      const id = `${model}:${thinking ? "thinking" : "text"}:${value.item_id ?? `output-${value.output_index ?? 0}`}:${value.summary_index ?? value.content_index ?? 0}`;
      put(id, thinking ? "thinking" : "text", at, thinking ? "Thinking" : "Assistant",
        value.delta ?? value.text ?? "", type.endsWith(".done"), type.endsWith(".delta"));
    } else if (/^response\.(function_call_arguments|custom_tool_call_input)\.(delta|done)$/.test(type)) {
      const id = aliases.get(value.item_id) ?? toolId(model, value.item_id);
      put(id, "tool", at, toolNames.get(id) ?? "工具", value.delta ?? value.arguments ?? value.input ?? "",
        type.endsWith(".done"), type.endsWith(".delta"));
    } else if (type === "response.reasoning_summary_part.done") {
      put(`${model}:thinking:${value.item_id}:${value.summary_index ?? 0}`, "thinking", at, "Thinking", value.part?.text ?? "", true);
    } else if (type === "response.content_part.done" && value.part?.type === "output_text") {
      put(`${model}:text:${value.item_id}:${value.content_index ?? 0}`, "text", at, "Assistant", value.part.text ?? "", true);
    } else if (type === "chat.completion.chunk") {
      for (const choice of value.choices ?? []) {
        const delta = choice.delta ?? {};
        const prefix = `${model}:chat:${value.id ?? responseId}:${choice.index ?? 0}`;
        for (const [field, kind] of [["reasoning_content", "thinking"], ["content", "text"]] as const) {
          if (typeof delta[field] === "string") put(`${prefix}:${kind}`, kind, at,
            kind === "thinking" ? "Thinking" : "Assistant", delta[field], false, true);
        }
        for (const tool of delta.tool_calls ?? []) {
          const slot = `${prefix}:tool:${tool.index ?? 0}`;
          if (tool.id) aliases.set(slot, toolId(model, tool.id));
          const id = aliases.get(slot) ?? slot;
          if (tool.function?.name) toolNames.set(id, tool.function.name);
          put(id, "tool", at, toolNames.get(id) ?? "工具", tool.function?.arguments ?? "", false, true);
        }
        if (choice.finish_reason) { state.terminal = true; for (const block of blocks.values()) block.status = "complete"; }
      }
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      state.terminal = true;
      for (const [i, output] of (value.response?.output ?? []).entries()) item(output, at, true, i);
      for (const block of blocks.values()) if (block.status === "running") block.status = type === "response.failed" ? "error" : "complete";
    } else if (!type.startsWith("response.content_part.") && !type.startsWith("response.reasoning_summary_part.")) {
      // Transport metadata remains available, but never repeat response snapshots.
      const { input: _input, output: _output, instructions: _instructions, tools: _tools, response, ...metadata } = value;
      if (response) metadata.response = { id: response.id, status: response.status, usage: response.usage };
      const id = `${model}:stream:${lineIndex}`;
      const text = readable(metadata);
      put(id, "diagnostic", at, type, text, true);
      blocks.get(id)!.data = structuredText(text) as Record<string, unknown>;
    }
  }
  state.blocks = [...blocks]; state.aliases = [...aliases]; state.toolNames = [...toolNames];
  state.seen = [...seen]; state.responseId = responseId;
  return [...blocks.values()].filter(block => block.text.trim() || block.kind === "tool")
    .map(block => block.kind === "tool" ? { ...block, text: argumentsText(block.text),
      tool: { args: structuredText(argumentsText(block.text)) } } : block);
}

export function streamBlocks(text: string, model: string, anchor: Pick<Event, "at" | "atMs"> & Partial<Event>): LogBlock[] {
  return advanceStream(text, model, anchor, emptyStream());
}
async function streamFile(path: string, model: string, anchor: Event): Promise<LogBlock[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error("无效的模型调用 ID");
  const file = join(path, "streams", `${model}.jsonl`);
  try {
    if (await realpath(file) !== file) throw new Error("流日志必须位于运行目录内");
    return streamBlocks(await readFile(file, "utf8"), model, anchor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function payloadText(path: string, value: any, index?: LogIndex): Promise<string> {
  if (!value?.path) return resultText(value);
  if (!/^payloads\/[a-f0-9]{64}\.json\.gz$/.test(value.path)) throw new Error("无效的工具结果路径");
  const saved = await index?.store("payloads").get<string>(value.path);
  if (saved !== undefined) return saved;
  const file = join(path, value.path);
  if (await realpath(file) !== file) throw new Error("工具结果必须位于运行目录内");
  const text = resultText(JSON.parse((await unpack(await readFile(file))).toString("utf8")));
  await index?.store("payloads").put(value.path, text);
  return text;
}

export async function activityBlocks(path: string, events: Event[]): Promise<LogBlock[]> {
  const calls = new Map<string, Event>();
  for (const event of events) if (event.trace.modelCallId && !calls.has(event.trace.modelCallId)) calls.set(event.trace.modelCallId, event);
  const blocks = new Map((await Promise.all([...calls].map(([id, anchor]) => streamFile(path, id, anchor))))
    .flat().map(block => [block.id, { ...block }]));
  await overlayEvents(path, events, blocks);
  return [...blocks.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
async function overlayEvents(path: string, events: Event[], blocks: Map<string, LogBlock>, index?: LogIndex) {
  const pythonMembers = new Map<string, { group: string; root: boolean }>();
  const executingTools = new Set(events.filter(event => event.type === "tool_start" && event.trace.modelCallId && event.trace.toolCallId)
    .map(event => toolId(event.trace.modelCallId, event.trace.toolCallId)));
  const tools = new Map<string, { name: string; intent: string; args: string; result: string }>();
  for (const event of events) {
    const { data, trace } = event;
    await projectPythonCall(event, blocks, pythonMembers, index);
    const id = trace.modelCallId && trace.toolCallId ? toolId(trace.modelCallId, trace.toolCallId) : null;
    if (id && ["tool_start", "tool_update", "tool_end", "exec", "exec_result"].includes(event.type)) {
      const previous = blocks.get(id);
      const tool = tools.get(id) ?? { name: previous?.title ?? "工具", intent: "", args: previous?.text ?? "", result: "" };
      if (data.toolName) tool.name = data.toolName;
      if (data.intent) tool.intent = data.intent;
      if (event.type === "tool_start") tool.args = argumentsText(data.args);
      if (event.type === "exec" && !tool.args) tool.args = argumentsText({ command: data.command });
      if (event.type === "exec_result") tool.result = readable(data);
      if (["tool_update", "tool_end"].includes(event.type) && data.result !== undefined)
        tool.result = await payloadText(path, data.result, index);
      tools.set(id, tool);
      blocks.set(id, { id, kind: "tool", at: previous?.at ?? event.at, title: tool.name, ...provenance(event),
        text: [tool.intent && `意图：${tool.intent}`, tool.args && `参数：\n${tool.args}`, tool.result && `结果：\n${tool.result}`].filter(Boolean).join("\n\n"),
        tool: { ...(tool.intent ? { intent: tool.intent } : {}), args: structuredText(tool.args),
          ...(tool.result ? { result: structuredText(tool.result) } : {}) },
        status: data.isError || previous?.status === "error" || (event.type === "exec_result" && data.exitCode !== 0) ? "error" : event.type === "tool_end" ? "complete" : "running" });
      continue;
    }
    const raised = event.type === "python_call_end" && data.outcome === "error";
    const assessment = ["benchmark_end", "benchmark_report", "benchmark_supervisor_end"].includes(event.type);
    const unmet = assessment && data.executionStatus === "completed" && data.reportStatus === "valid" && data.verdict === "failed";
    const failed = !raised && ((assessment && (data.executionStatus === "error" || data.reportStatus === "invalid"))
      || data.outcome === "error" || (event.type === "perception_status" && data.state === "error") || (data.outcome !== "cancelled" && !data.aborted
      && (event.type.endsWith("_error") || data.isError === true || data.stopReason === "error")));
    if (event.type === "model_end") {
      for (const block of blocks.values()) {
        if (!block.id.startsWith(`${trace.modelCallId}:`) || block.status !== "running") continue;
        // The model can stop before execution starts. Tool execution owns its
        // own terminal state; only an unexecuted, interrupted tool is closed here.
        if (block.kind === "thinking" || block.kind === "text" ||
          (block.kind === "tool" && !executingTools.has(block.id) && ["aborted", "error"].includes(data.stopReason))) {
          block.status = failed ? "error" : "complete";
        }
      }
    }
    const system = failed || assessment || event.type === "control" || event.type === "perception_status"
      || event.type.startsWith("background_") || event.type.includes("compaction") || event.type === "run_end";
    blocks.set(`event:${path.split("/").at(-1)}:${event.seq}`, {
      id: `event:${path.split("/").at(-1)}:${event.seq}`, kind: system ? "system" : "diagnostic",
      at: event.at, title: event.type, text: readable(data), data: structuredText(readable(data)) as Record<string, unknown>,
      ...provenance(event),
      status: failed ? "error" : "complete",
      ...(raised ? { outcome: "raised" as const } : {}),
      ...(unmet ? { outcome: "unmet" as const } : {}),
    });
  }
}


const TOOL_EVENTS = ["tool_start", "tool_update", "tool_end", "exec", "exec_result", "model_end"];
async function saveBlock(index: LogIndex, block: LogBlock) {
  const store = index.store("blocks");
  const prior = store.meta(block.id);
  const { createdRevision: _created, revision: _revision, ...content } = block;
  const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  if (prior?.digest === digest) return;
  const revision = index.revision + 1;
  const createdRevision = prior ? Number(prior.createdRevision) : revision;
  const value = { ...content, createdRevision, revision };
  // Immutable versions preserve creation order when a late update lands beyond
  // a consumer's current page. The index holds only metadata, never block text.
  await store.put(block.id, value, { model: block.trace?.modelCallId ?? null, epoch: block.trace?.epoch ?? null,
    at: block.at, kind: block.kind, status: block.status, createdRevision, revision, digest });
  index.setMeta("revision", revision);
}
interface CurrentState {
  phase: LivePhaseState; intent: string | null; observationId: string | null;
  updatedAt: string | null; error: string | null;
}
const emptyCurrent = (): CurrentState => ({ phase: emptyLivePhase(), intent: null, observationId: null, updatedAt: null, error: null });
async function projectEvents(index: LogIndex) {
  let position = Number(index.meta("activityPosition") ?? 0);
  const dirty = new Set<string>(JSON.parse(index.meta("activityDirty") ?? "[]"));
  for (;;) {
    const page = await index.queryEvents({ afterPosition: position, limit: 250 });
    if (!page.length) break;
    const ordinary = new Map<string, LogBlock>();
    const current = new Map<string, CurrentState>();
    const phases = new Map<string, Event[]>();
    await overlayEvents(index.path, page.map(row => row.event).filter(event =>
      !(event.trace?.modelCallId && TOOL_EVENTS.includes(event.type))), ordinary, index);
    for (const block of ordinary.values()) await saveBlock(index, block);
    for (const { event } of page) {
      const model = event.trace?.modelCallId;
      if (model) {
        if (!index.store("streams").meta(model)) await index.store("streams").put(model, { anchor: event, state: emptyStream() });
        dirty.add(model);
      }
      const key = `current:${event.trace?.epoch ?? ""}`;
      let state = current.get(key);
      if (!state) { state = JSON.parse(index.meta(key) ?? "null") ?? emptyCurrent(); current.set(key, state!); }
      const phaseEvents = phases.get(key) ?? [];
      phaseEvents.push(event); phases.set(key, phaseEvents);
      state!.updatedAt = event.at;
      if (event.type === "model_start") state!.error = null;
      if (event.type === "tool_start" && event.data.intent) state!.intent = event.data.intent;
      for (const observation of eventObservations(event)) {
        if (observation.mediaType?.startsWith("image/") && !index.store("images").meta(observation.id))
          await index.store("images").put(observation.id, true);
      }
      if (event.type === "model_start") {
        const images = (event.data.observations ?? []).filter((id: string) => index.store("images").meta(id));
        state!.observationId = images.at(-1) ?? null;
      }
      if (event.type.endsWith("_error")) state!.error = event.data.error ? String(event.data.error) : null;
      if (event.type === "control" && event.data.mode === "auto") {
        const epochs: string[] = JSON.parse(index.meta("activityEpochs") ?? "[]");
        if (event.trace.epoch && !epochs.includes(event.trace.epoch)) epochs.push(event.trace.epoch);
        index.setMeta("activityEpochs", JSON.stringify(epochs));
      }
      index.setMeta(`latest:${event.trace?.epoch ?? ""}`, JSON.stringify({ seq: event.seq, at: event.at, origin: event.origin }));
      index.setMeta("activityLatest", JSON.stringify({ seq: event.seq, at: event.at, origin: event.origin }));
    }
    for (const [key, state] of current) {
      advanceLivePhase(state.phase, phases.get(key)!);
      index.setMeta(key, JSON.stringify(state));
    }
    position = page.at(-1)!.position;
    index.setMeta("activityPosition", position);
    index.setMeta("activityDirty", JSON.stringify([...dirty]));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return dirty;
}
async function projectModel(index: LogIndex, model: string, changed: boolean) {
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error("无效的模型调用 ID");
  const relative = `streams/${model}.jsonl`;
  let next = await index.readAppend(relative);
  if (!changed && !next?.changed) return;
  const saved = (await index.store("streams").get<{ anchor: Event; state: StreamState }>(model))!;
  const { anchor, state } = saved;
  let projected = advanceStream("", model, anchor, state);
  let lastOffset = -1;
  while (next?.changed && next.state.offset !== lastOffset) {
    lastOffset = next.state.offset;
    projected = advanceStream(next.text, model, anchor, state);
    index.saveFile(next.state);
    if (next.state.offset === next.state.size || !next.text) break;
    next = await index.readAppend(relative);
  }
  await index.store("streams").put(model, { anchor, state });
  const blocks = new Map(projected.map(block => [block.id, block]));
  let position = 0;
  const events: Event[] = [];
  // Only one call's tool lifecycle is read; unrelated history stays on disk.
  for (;;) {
    const page = await index.queryEvents({ model, afterPosition: position, types: TOOL_EVENTS });
    if (!page.length) break;
    events.push(...page.map(row => row.event)); position = page.at(-1)!.position;
  }
  await overlayEvents(index.path, events, blocks, index);
  for (const block of blocks.values()) await saveBlock(index, block);
}
const refreshes = new WeakMap<LogIndex, Promise<void>>();
/** Incremental source ingestion; no historical Event[] or global block array. */
export function refreshActivity(index: LogIndex) {
  let pending = refreshes.get(index);
  if (!pending) {
    pending = index.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // Presentation changes invalidate only the disposable index, never source logs.
          if (index.meta("activitySemantics") !== "3") { index.resetActivity(); index.setMeta("activitySemantics", "3"); }
          await index.appendEvents();
          const dirty = await projectEvents(index);
          // Checking file metadata also notices a late stream append or replacement
          // after model_end. Parser states are loaded only for changed calls.
          for (const row of index.store("streams").entries())
            await projectModel(index, row.id, dirty.has(row.id));
          index.setMeta("activityDirty", "[]");
          break;
        } catch (error) {
          if (!(error instanceof SourceChanged) || attempt) throw error;
          await index.reset();
        }
      }
    }).finally(() => refreshes.delete(index));
    refreshes.set(index, pending);
  }
  return pending;
}

export interface ActivityScope { project: string; runId: string | null; epoch: string | null }
export interface ActivityQuery {
  mode?: "changes" | "history" | "block"; cursor?: string; before?: string;
  kind?: string; q?: string; limit?: number; id?: string;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value?: string): any { try { return value ? JSON.parse(Buffer.from(value, "base64url").toString()) : null; } catch { return null; } }
const lexical = (left: string, right: string) => left === right ? 0 : left < right ? -1 : 1;
const ascending = (blocks: LogBlock[]) => blocks.sort((a, b) => lexical(a.at, b.at) || lexical(a.id, b.id));
const byPosition = (a: RecordPointer, b: RecordPointer) => lexical(String(a.at), String(b.at)) || lexical(a.id, b.id);
/** Retain only a page of pointers, with the oldest selected pointer at the root. */
function newestPointers(limit: number) {
  const heap: RecordPointer[] = [];
  return {
    add(pointer: RecordPointer) {
      if (heap.length < limit) {
        let child = heap.push(pointer) - 1;
        while (child) {
          const parent = (child - 1) >>> 1;
          if (byPosition(heap[parent], heap[child]) <= 0) break;
          [heap[parent], heap[child]] = [heap[child], heap[parent]]; child = parent;
        }
      } else if (byPosition(pointer, heap[0]) > 0) {
        heap[0] = pointer;
        let parent = 0;
        for (;;) {
          let child = parent * 2 + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && byPosition(heap[child + 1], heap[child]) < 0) child++;
          if (byPosition(heap[parent], heap[child]) <= 0) break;
          [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child;
        }
      }
    },
    values: () => heap.sort((a, b) => byPosition(b, a)),
  };
}
function selectedEpoch(index: LogIndex, requested?: string) {
  const epochs: string[] = JSON.parse(index.meta("activityEpochs") ?? "[]");
  if (requested && !epochs.includes(requested)) throw new Error("未找到接管轮次");
  return requested ?? epochs.at(-1) ?? null;
}
/** Read one page of full blocks; filtering and pagination retain only pointers. */
export async function queryActivity(index: LogIndex, scope: ActivityScope, query: ActivityQuery = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 100) || 100, 500));
  const store = index.store("blocks");
  const generation = index.generation;
  const head = index.revision;
  const token = (extra: object) => encode({ scope, generation, ...extra });
  const bound = (value: any) => value?.generation === generation && JSON.stringify(value.scope) === JSON.stringify(scope);
  const inEpoch = (pointer: RecordPointer) => !scope.epoch || pointer.epoch === scope.epoch;
  const epochFilter = scope.epoch ? { epoch: scope.epoch } : {};
  const latest: Event | null = JSON.parse(index.meta(scope.epoch ? `latest:${scope.epoch}` : "activityLatest") ?? "null");
  const projection = { source: { component: "dashboard" }, throughSeq: latest?.seq ?? 0,
    latestEventAt: latest?.at ?? null, latestSourceAt: latest?.origin?.at ?? latest?.at ?? null,
    generatedAt: new Date().toISOString(), durationMs: 0,
    blockCount: store.count(epochFilter), revision: head, generation };
  const read = (items: RecordPointer[]) => Promise.all(items.map(item => store.read<LogBlock>(item)));
  let examined = 0;
  const yieldRead = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    signal?.throwIfAborted();
  };
  if (query.mode === "block") {
    const pointer = store.meta(query.id ?? "");
    return { scope, mode: "block" as const, blocks: pointer && inEpoch(pointer) ? await read([pointer]) : [], hasMore: false, projection };
  }
  if (query.mode === "history") {
    const kind = query.kind ?? "all", q = (query.q ?? "").trim().toLocaleLowerCase();
    if (!["all", "thinking", "text", "tool", "system", "diagnostic"].includes(kind)) throw new Error("无效的日志类型");
    const before = decode(query.before);
    const validBefore = bound(before) && before.kind === kind && before.q === q && typeof before.at === "string" && typeof before.id === "string";
    const selected = newestPointers(limit);
    let total = 0, eligible = 0;
    for (const pointer of store.entries({ where: { ...epochFilter, ...(kind === "all" ? {} : { kind }) } })) {
      if (++examined % 250 === 0) await yieldRead();
      if (!inEpoch(pointer) || (kind === "all" ? pointer.kind === "diagnostic" : pointer.kind !== kind)) continue;
      // Search scans disk lazily. Neither all pointers nor matching bodies are retained.
      const block = q ? await store.read<LogBlock>(pointer) : undefined;
      if (q && !activitySearchText(block!).includes(q)) continue;
      total++;
      if (validBefore && !(String(pointer.at) < before.at || (pointer.at === before.at && pointer.id < before.id))) continue;
      eligible++; selected.add(pointer);
    }
    const page = await read(selected.values()), hasMore = eligible > limit;
    const oldest = page.at(-1);
    return { scope, mode: "history" as const, blocks: ascending(page), total, hasMore,
      before: hasMore && oldest ? token({ kind, q, at: oldest.at, id: oldest.id }) : null, projection };
  }
  const cursor = decode(query.cursor);
  if (bound(cursor) && Number.isSafeInteger(cursor.revision) && cursor.revision >= 0 && cursor.revision <= head) {
    const page: RecordPointer[] = [];
    // The store seeks the first relevant revision page; old versions stay on disk.
    for (const pointer of store.versions({ after: cursor.revision, before: head + 1, where: epochFilter })) {
      if (++examined % 250 === 0) await yieldRead();
      if (Number(pointer.revision) > head) break;
      if (inEpoch(pointer)) page.push(pointer);
      if (page.length > limit) break;
    }
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    const revision = hasMore ? Number(page.at(-1)!.revision) : head;
    return { scope, mode: "delta" as const, blocks: await read(page), cursor: token({ revision }), hasMore,
      projection: { ...projection, revision } };
  }
  const recent = newestPointers(limit), running = newestPointers(500);
  for (const pointer of store.entries({ where: epochFilter })) {
    if (++examined % 250 === 0) await yieldRead();
    if (!inEpoch(pointer)) continue;
    recent.add(pointer);
    // Preserve live tools outside the recent page, without an unbounded response
    // if a damaged log contains thousands of never-completed blocks.
    if (pointer.status === "running") running.add(pointer);
  }
  const selected = new Map([...recent.values(), ...running.values()].map(pointer => [pointer.id, pointer]));
  return { scope, mode: "snapshot" as const, blocks: ascending(await read([...selected.values()])),
    cursor: token({ revision: head }), hasMore: false, projection };
}

export async function getActivity(project: string, run?: string, epoch?: string, query: ActivityQuery = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  const projects = await catalog(undefined, true);
  const selected = projects.find(value => value.id === project);
  if (!selected) throw new Error("未找到工作区");
  const latest = latestGameRun(selected)?.id;
  const runId = run || latest;
  if (!runId) return { scope: { project, runId: null, epoch: null }, mode: "snapshot", blocks: [], cursor: null, hasMore: false,
    projection: { source: { component: "dashboard" }, throughSeq: 0, latestEventAt: null, latestSourceAt: null,
      generatedAt: new Date().toISOString(), durationMs: performance.now() - started, blockCount: 0, revision: 0, generation: "empty" },
    current: { workspace: selected.workspace ?? null, runId: null, epoch: null, activity: "idle", phase: "工作区尚无运行记录",
      intent: null, observationId: null, updatedAt: null, error: null } };
  const { manifest, index, release } = await loadRun(project, runId);
  try {
  await refreshActivity(index);
  // Readers may leave; shared projection work remains available to other consumers.
  signal?.throwIfAborted();
  const selectedState = await index.exclusive(async () => {
    const scope = { project, runId, epoch: selectedEpoch(index, epoch) };
    const state: CurrentState = JSON.parse(index.meta(`current:${scope.epoch ?? ""}`) ?? "null") ?? emptyCurrent();
    return { scope, state };
  });
  // Pointer snapshots refer to immutable versions. A long history search does
  // not hold the writer lock or delay Pet's next incremental page.
  const result = { ...await queryActivity(index, selectedState.scope, query, signal), state: selectedState.state };
  const live = latest === runId && manifest.kind !== "benchmark"
    ? await hostRequest(manifest.socket, { kind: "status", argv: [] }).catch(() => null) : null;
  const selectedCurrent = live?.runId === runId && (live.mode === "manual" || live.epoch === result.scope.epoch);
  const connected = selectedCurrent && live?.connected;
  const activity = connected ? (live.mode === "auto" && live.epoch === result.scope.epoch ? "running" : "manual") : "offline";
  const { state, ...response } = result;
  response.projection.durationMs = performance.now() - started;
  return { ...response, current: { workspace: selected.workspace ?? manifest.workspace ?? null, runId, epoch: result.scope.epoch,
    activity, phase: activity === "running" ? livePhaseValue(state.phase)?.label ?? "等待下一步"
      : activity === "manual" ? (result.scope.epoch ? "已交还控制权" : "已连接，等待 AI 接管")
      : live?.runId === runId && live.mode === "auto" && live.epoch !== result.scope.epoch ? "历史运行，仅供回放"
      : live?.runId === runId && !live.connected ? "设备连接已断开" : "Host 离线",
    intent: state.intent, observationId: state.observationId, updatedAt: state.updatedAt, error: state.error } };
  } finally { release(); }
}
