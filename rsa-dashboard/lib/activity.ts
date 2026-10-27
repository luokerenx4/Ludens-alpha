import { readFile, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { catalog, hostRequest, openRun } from "./data";
import { prepareArchive } from "./prepare-run";
import { latestGameRun } from "./initial-selection";
import { LogIndex, SourceChanged, type RecordPointer } from "./log-index";
import { activitySearchText } from "../components/activity-feed-model";
import { advanceLivePhase, emptyLivePhase, livePhaseValue, type LivePhaseState } from "./live-phase";
import { eventObservations } from "./observation-events";
import type { Event } from "./types";
import { projectPythonCall, pythonSummaryBlock, type PythonSummary } from "./python-activity";
import { readArtifact } from "../../shared/log-archive";

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
const callId = (id: string) => id.split("|")[0];
const toolId = (model: string, id: string) => `${model}:tool:${callId(id)}`;
const hidden = new Set(["encrypted_content", "thinkingSignature", "signature", "redactedThinking"]);
function mediaReferences(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  if ("$media" in value) return [value];
  return Object.values(value).flatMap(mediaReferences);
}
function readable(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, (key, item) => {
    if (hidden.has(key)) return undefined;
    if (item && typeof item === "object" && ["image", "input_image", "audio"].includes(item.type)) {
      const media = mediaReferences(item);
      return { type: item.type, mimeType: item.mimeType, ...(media.length ? { media } : {}) };
    }
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
    .flatMap((part: Json) => part.type === "text" && typeof part.text === "string"
      ? [argumentsText(part.text)] : mediaReferences(part).length ? [readable(part)] : []).join("\n\n");
  return readable(value);
}

/** Project raw provider output only; request input/history is never a new block. */
interface StreamState {
  blocks: [string, LogBlock][]; aliases: [string, string][]; toolNames: [string, string][];
  seen: string[]; responseId: string; line: number; terminal: boolean;
}
const emptyStream = (): StreamState => ({ blocks: [], aliases: [], toolNames: [], seen: [], responseId: "", line: 0, terminal: false });
function advanceStream(rows: Iterable<Json>, model: string, anchor: Pick<Event, "at" | "atMs"> & Partial<Event>, state: StreamState): LogBlock[] {
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
  for (const row of rows) {
    const lineIndex = state.line++;
    origin = { ...provenance(anchor), source: row.source ?? anchor.source, trace: { ...anchor.trace, ...row.trace } };
    const wire = row.event ?? row;
    // A WS upload may contain the entire conversation and base64 observations.
    if (wire.event === "response.create" || wire.type === "response.create" || wire.data === "[DONE]") continue;
    let value: Json = wire.data ?? wire;
    if (typeof value === "string") {
      try { value = JSON.parse(value); }
      catch { value = { type: wire.event ?? "stream", data: value }; }
    }
    if (!value || typeof value !== "object") value = { type: wire.event ?? "stream", data: value };
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

function* streamRows(text: string): Generator<Json> {
  const lines = text.split("\n"); lines.pop();
  for (const line of lines) if (line.trim()) yield JSON.parse(line);
}
async function artifact(path: string, reference: any, workspace?: string | null) {
  return readArtifact(path, { encoding: "gzip", ...reference }, { media: "reference", workspace });
}
async function storedStream(text: string, path: string, model: string, anchor: Event, state: StreamState, workspace?: string | null) {
  const rows: Json[] = [];
  for (const row of streamRows(text)) {
    const wire = row.event ?? row;
    // Skip uploads before dereferencing: their entire input history is not activity.
    if (row.format === "rsa-stream-v1" && wire.event !== "response.create" && wire.type !== "response.create") {
      const data = await artifact(path, wire.dataRef, workspace);
      rows.push({ ...row, event: { ...wire, data } });
    } else rows.push(row);
  }
  return advanceStream(rows, model, anchor, state);
}

export function streamBlocks(text: string, model: string, anchor: Pick<Event, "at" | "atMs"> & Partial<Event>): LogBlock[] {
  return advanceStream(streamRows(text), model, anchor, emptyStream());
}
async function streamFile(path: string, model: string, anchor: Event, workspace?: string | null): Promise<LogBlock[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error("无效的模型调用 ID");
  const file = join(path, "streams", `${model}.jsonl`);
  try {
    if (await realpath(file) !== file) throw new Error("流日志必须位于运行目录内");
    return storedStream(await readFile(file, "utf8"), path, model, anchor, emptyStream(), workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function payloadText(path: string, value: any, index?: LogIndex, workspace?: string | null): Promise<string> {
  if (!value?.path) return resultText(value);
  return resultText(await artifact(path, value, workspace));
}

export async function activityBlocks(path: string, events: Event[], workspace?: string | null): Promise<LogBlock[]> {
  const calls = new Map<string, Event>();
  for (const event of events) if (event.trace.modelCallId && !calls.has(event.trace.modelCallId)) calls.set(event.trace.modelCallId, event);
  const blocks = new Map((await Promise.all([...calls].map(([id, anchor]) => streamFile(path, id, anchor, workspace))))
    .flat().map(block => [block.id, { ...block }]));
  await overlayEvents(path, events, blocks, undefined, workspace);
  return [...blocks.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
async function overlayEvents(path: string, events: Event[], blocks: Map<string, LogBlock>, index?: LogIndex, workspace = index?.archiveWorkspace) {
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
      if (event.type === "tool_start") tool.args = argumentsText(data.argsRef
        ? await artifact(path, data.argsRef, workspace) : data.args);
      if (event.type === "exec" && !tool.args) tool.args = argumentsText({ command: data.command });
      if (event.type === "exec_result") tool.result = readable(data);
      if (["tool_update", "tool_end"].includes(event.type) && data.result !== undefined)
        tool.result = await payloadText(path, data.result, index, workspace);
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
type BlockRecipe = { kind: "event"; position: number }
  | { kind: "model"; model: string; anchorPosition: number; streamOffset: number; eventCutoff: number }
  | { kind: "python"; position: number; summary: PythonSummary; exceptionPosition?: number };
async function saveBlock(index: LogIndex, block: LogBlock, recipe: BlockRecipe) {
  const store = index.store("blocks"), prior = store.meta(block.id);
  const { createdRevision: _created, revision: _revision, ...content } = block;
  const digest = recipe.kind === "event" ? undefined : createHash("sha256").update(JSON.stringify(content)).digest("hex");
  if (prior && (recipe.kind === "event" || prior.digest === digest)) return;
  const revision = index.revision + 1, createdRevision = prior ? Number(prior.createdRevision ?? prior.revision) : revision;
  store.index(block.id, { recipe, ...(block.trace?.epoch ? { epoch: block.trace.epoch } : {}), at: block.at, kind: block.kind,
    status: block.status, ...(recipe.kind === "python" ? { updatedAt: block.updatedAt } : {}),
    ...(createdRevision !== revision ? { createdRevision } : {}), revision, ...(digest ? { digest } : {}) });
  index.setMeta("revision", revision);
}

/** Source cutoffs make a delivery version immutable without copying its rendered text. */
async function modelBlocks(index: LogIndex, recipe: Extract<BlockRecipe, { kind: "model" }>, signal?: AbortSignal): Promise<LogBlock[]> {
  const anchor = await index.readEvent(recipe.anchorPosition);
  if (!anchor) throw new Error("模型来源事件不存在");
  const state = emptyStream(), path = join(index.path, "streams", `${recipe.model}.jsonl`);
  let projected: LogBlock[] = [], pending = Buffer.alloc(0), offset = 0;
  if (recipe.streamOffset) {
    if (await realpath(path) !== path) throw new Error("流日志必须位于运行目录内");
    const file = await open(path, "r");
    try {
      while (offset < recipe.streamOffset) {
        signal?.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(1024 * 1024, recipe.streamOffset - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new SourceChanged(path);
        offset += bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        const end = pending.lastIndexOf(10) + 1;
        if (end) { projected = await storedStream(pending.subarray(0, end).toString("utf8"), index.path,
          recipe.model, anchor, state, index.archiveWorkspace); pending = pending.subarray(end); }
      }
    } finally { await file.close(); }
  }
  const blocks = new Map(projected.map(block => [block.id, block])), events: Event[] = [];
  let position = 0;
  for (;;) {
    const page = await index.queryEvents({ model: recipe.model, afterPosition: position,
      beforePosition: recipe.eventCutoff + 1, types: TOOL_EVENTS, signal });
    if (!page.length) break;
    events.push(...page.map(row => row.event)); position = page.at(-1)!.position;
  }
  await overlayEvents(index.path, events, blocks, undefined, index.archiveWorkspace);
  return [...blocks.values()];
}
function blockReader(index: LogIndex, signal?: AbortSignal) {
  const cached = new Map<string, { blocks: Map<string, LogBlock>; bytes: number }>();
  let bytes = 0;
  return async (row: RecordPointer): Promise<LogBlock> => {
    signal?.throwIfAborted();
    const recipe = row.recipe as BlockRecipe;
    let block: LogBlock | undefined;
    if (recipe.kind === "event") {
      const event = await index.readEvent(recipe.position);
      if (!event) throw new Error("活动来源事件不存在");
      const blocks = new Map<string, LogBlock>(); await overlayEvents(index.path, [event], blocks, undefined, index.archiveWorkspace);
      block = blocks.get(row.id);
    } else if (recipe.kind === "python") {
      const event = await index.readEvent(recipe.position);
      if (!event) throw new Error("Python 来源事件不存在");
      const summary = { ...recipe.summary };
      if (recipe.exceptionPosition && summary.lastException) {
        const exception = await index.readEvent(recipe.exceptionPosition);
        summary.lastException = { ...summary.lastException, error: exception?.data.error };
      }
      block = pythonSummaryBlock(event, row.id, summary, row.updatedAt);
    } else {
      const key = JSON.stringify(recipe); let entry = cached.get(key);
      if (!entry) {
        const blocks = await modelBlocks(index, recipe, signal), weight = Buffer.byteLength(JSON.stringify(blocks));
        entry = { blocks: new Map(blocks.map(value => [value.id, value])), bytes: weight };
        if (weight <= 8 * 1024 * 1024) {
          while (bytes + weight > 8 * 1024 * 1024 && cached.size) {
            const first = cached.keys().next().value!; bytes -= cached.get(first)!.bytes; cached.delete(first);
          }
          cached.set(key, entry); bytes += weight;
        }
      }
      block = entry.blocks.get(row.id);
    }
    if (!block) throw new Error(`活动来源无法重建：${row.id}`);
    return { ...block, createdRevision: row.createdRevision ?? row.revision, revision: row.revision };
  };
}

interface CurrentState {
  phase: LivePhaseState; intent: string | null; observationId: string | null;
  updatedAt: string | null; error: string | null;
}
const emptyCurrent = (): CurrentState => ({ phase: emptyLivePhase(), intent: null, observationId: null, updatedAt: null, error: null });
async function projectEvents(index: LogIndex, options: ActivityBatch = {}) {
  let processed = 0;
  let position = Number(index.meta("activityPosition") ?? 0);
  const dirty = new Set<string>(JSON.parse(index.meta("activityDirty") ?? "[]"));
  for (;;) {
    options.signal?.throwIfAborted();
    if (processed >= (options.maxEvents ?? Infinity)) break;
    const page = await index.queryEvents({ afterPosition: position, limit: Math.min(250, (options.maxEvents ?? Infinity) - processed) });
    if (!page.length) break;
    processed += page.length;
    const ordinary = new Map<string, LogBlock>();
    const current = new Map<string, CurrentState>();
    const phases = new Map<string, Event[]>();
    await overlayEvents(index.path, page.map(row => row.event).filter(event =>
      !(event.trace?.modelCallId && TOOL_EVENTS.includes(event.type))), ordinary, index);
    const positions = new Map(page.map(row => [row.event.seq, row.position]));
    for (const block of ordinary.values()) {
      const previous = index.store("blocks").meta(block.id)?.recipe as BlockRecipe | undefined;
      const position = positions.get(block.seq!) ?? (previous && "position" in previous ? previous.position : undefined);
      if (!position) throw new Error("活动块缺少原始事件位置");
      let recipe: BlockRecipe = { kind: "event", position };
      if (block.id.startsWith("python:")) {
        const summary = structuredClone(block.data) as PythonSummary;
        const exceptionPosition = summary.lastException ? positions.get(summary.lastException.seq)
          ?? (previous?.kind === "python" ? previous.exceptionPosition : undefined) : undefined;
        if (summary.lastException) delete summary.lastException.error;
        recipe = { kind: "python", position, summary, ...(exceptionPosition ? { exceptionPosition } : {}) };
      }
      await saveBlock(index, block, recipe);
    }
    for (const { event, position: eventPosition } of page) {
      const model = event.trace?.modelCallId;
      if (model) {
        if (!index.store("streams").meta(model)) index.store("streams").index(model, { anchorPosition: eventPosition, offset: 0 });
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
          index.store("images").index(observation.id, {});
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
async function projectModel(index: LogIndex, model: string, changed: boolean, signal?: AbortSignal) {
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error("无效的模型调用 ID");
  const relative = `streams/${model}.jsonl`;
  let next = await index.readAppend(relative);
  if (!changed && !next?.changed) return;
  const saved = index.store("streams").meta(model)!;
  let streamOffset = Number(saved.offset ?? 0), lastOffset = -1;
  while (next?.changed && next.state.offset !== lastOffset) {
    lastOffset = next.state.offset; streamOffset = next.state.offset;
    index.saveFile(next.state);
    if (next.state.offset === next.state.size || !next.text) break;
    next = await index.readAppend(relative);
  }
  if (next) index.saveFile(next.state);
  index.store("streams").index(model, { anchorPosition: saved.anchorPosition, offset: streamOffset });
  const recipe: BlockRecipe = { kind: "model", model, anchorPosition: saved.anchorPosition,
    streamOffset, eventCutoff: Number(index.meta("activityPosition") ?? 0) };
  for (const block of await modelBlocks(index, recipe, signal)) await saveBlock(index, block, recipe);
}
export interface ActivityBatch { maxEvents?: number; maxBytes?: number; signal?: AbortSignal; ingest?: boolean }
export function activityProgress(index: LogIndex) {
  const position = Number(index.meta("activityPosition") ?? 0);
  return { position, total: index.eventRevision, complete: position >= index.eventRevision && index.progress.complete };
}
const refreshes = new WeakMap<LogIndex, { promise: Promise<void>; signal?: AbortSignal }>();
/** Incremental source ingestion; no historical Event[] or global block array. */
export function refreshActivity(index: LogIndex, options: ActivityBatch = {}) {
  let pending = refreshes.get(index);
  if (!pending || pending.signal?.aborted) {
    const next = { promise: undefined! as Promise<void>, signal: options.signal };
    next.promise = index.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // Presentation changes invalidate only the disposable index, never source logs.
          if (index.meta("activitySemantics") !== "5") { index.resetActivity(); index.setMeta("activitySemantics", "5"); }
          if (options.ingest !== false) await index.appendEvents({ maxBytes: options.maxBytes, signal: options.signal });
          const dirty = await projectEvents(index, options);
          // Checking file metadata also notices a late stream append or replacement
          // after model_end. Parser states are loaded only for changed calls.
          for (const row of index.store("streams").entries()) {
            options.signal?.throwIfAborted(); await projectModel(index, row.id, dirty.has(row.id), options.signal);
          }
          index.setMeta("activityDirty", "[]");
          break;
        } catch (error) {
          if (!(error instanceof SourceChanged) || attempt) throw error;
          await index.reset();
        }
      }
    }).finally(() => { if (refreshes.get(index) === next) refreshes.delete(index); });
    refreshes.set(index, next); pending = next;
  }
  return pending.promise;
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
  const generation = index.meta("activityGeneration") ?? index.generation;
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
  const hydrate = blockReader(index, signal);
  const read = async (items: RecordPointer[]) => { const blocks: LogBlock[] = []; for (const item of items) blocks.push(await hydrate(item)); return blocks; };
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
      const block = q ? await hydrate(pointer) : undefined;
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
  const { manifest, index, release } = await openRun(project, runId);
  try {
  await prepareArchive(index, { kind: "activity", step: signal => refreshActivity(index, { maxEvents: 2000, ingest: false, signal }),
    progress: () => activityProgress(index), signal });
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
