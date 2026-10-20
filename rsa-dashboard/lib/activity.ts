import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { loadRun, selectRunEvents } from "./data";
import type { Event } from "./types";

export interface LogBlock {
  id: string;
  kind: "thinking" | "text" | "tool" | "system" | "diagnostic";
  at: string;
  title: string;
  text: string;
  status: "running" | "complete" | "error";
  tool?: { intent?: string; args?: unknown; result?: unknown };
  data?: Record<string, unknown>;
  source?: Event["source"];
  trace?: Event["trace"];
  eventId?: string;
  seq?: number;
  updatedAt?: string;
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
export function streamBlocks(text: string, model: string, anchor: Pick<Event, "at" | "atMs"> & Partial<Event>): LogBlock[] {
  const blocks = new Map<string, LogBlock>();
  const aliases = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const seen = new Set<string>();
  let responseId = "";
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
  if (!text.endsWith("\n")) lines.pop();
  for (const [lineIndex, line] of lines.entries()) {
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
        if (choice.finish_reason) for (const block of blocks.values()) block.status = "complete";
      }
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
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
  return [...blocks.values()].filter(block => block.text.trim() || block.kind === "tool")
    .map(block => block.kind === "tool" ? { ...block, text: argumentsText(block.text),
      tool: { args: structuredText(argumentsText(block.text)) } } : block);
}

const streamCache = new Map<string, { mtime: number; size: number; blocks: LogBlock[] }>();
const payloadCache = new Map<string, { mtime: number; size: number; text: string }>();
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key); cache.set(key, value);
  if (cache.size > 1024) cache.delete(cache.keys().next().value!);
}
async function streamFile(path: string, model: string, anchor: Event): Promise<LogBlock[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error("无效的模型调用 ID");
  const file = join(path, "streams", `${model}.jsonl`);
  try {
    if (await realpath(file) !== file) throw new Error("流日志必须位于运行目录内");
    const s = await stat(file), cached = streamCache.get(file);
    if (cached?.mtime === s.mtimeMs && cached.size === s.size) return cached.blocks;
    const blocks = streamBlocks(await readFile(file, "utf8"), model, anchor);
    remember(streamCache, file, { mtime: s.mtimeMs, size: s.size, blocks });
    return blocks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function payloadText(path: string, value: any): Promise<string> {
  if (!value?.path) return resultText(value);
  if (!/^payloads\/[a-f0-9]{64}\.json\.gz$/.test(value.path)) throw new Error("无效的工具结果路径");
  const file = join(path, value.path);
  if (await realpath(file) !== file) throw new Error("工具结果必须位于运行目录内");
  const s = await stat(file), cached = payloadCache.get(file);
  if (cached?.mtime === s.mtimeMs && cached.size === s.size) return cached.text;
  const text = resultText(JSON.parse((await unpack(await readFile(file))).toString("utf8")));
  remember(payloadCache, file, { mtime: s.mtimeMs, size: s.size, text });
  return text;
}

export async function activityBlocks(path: string, events: Event[]): Promise<LogBlock[]> {
  const calls = new Map<string, Event>();
  for (const event of events) if (event.trace.modelCallId && !calls.has(event.trace.modelCallId)) calls.set(event.trace.modelCallId, event);
  const blocks = new Map((await Promise.all([...calls].map(([id, anchor]) => streamFile(path, id, anchor))))
    .flat().map(block => [block.id, { ...block }]));
  const executingTools = new Set(events.filter(event => event.type === "tool_start" && event.trace.modelCallId && event.trace.toolCallId)
    .map(event => toolId(event.trace.modelCallId, event.trace.toolCallId)));
  const tools = new Map<string, { name: string; intent: string; args: string; result: string }>();
  for (const event of events) {
    const { data, trace } = event;
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
        tool.result = await payloadText(path, data.result);
      tools.set(id, tool);
      blocks.set(id, { id, kind: "tool", at: previous?.at ?? event.at, title: tool.name, ...provenance(event),
        text: [tool.intent && `意图：${tool.intent}`, tool.args && `参数：\n${tool.args}`, tool.result && `结果：\n${tool.result}`].filter(Boolean).join("\n\n"),
        tool: { ...(tool.intent ? { intent: tool.intent } : {}), args: structuredText(tool.args),
          ...(tool.result ? { result: structuredText(tool.result) } : {}) },
        status: data.isError || previous?.status === "error" || (event.type === "exec_result" && data.exitCode !== 0) ? "error" : event.type === "tool_end" ? "complete" : "running" });
      continue;
    }
    const failed = data.outcome === "error" || (event.type === "perception_status" && data.state === "error") || (data.outcome !== "cancelled" && !data.aborted
      && (event.type.endsWith("_error") || data.isError === true || data.stopReason === "error"));
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
    const system = failed || event.type === "control" || event.type === "perception_status"
      || event.type.startsWith("background_") || event.type.includes("compaction") || event.type === "run_end";
    blocks.set(`event:${path.split("/").at(-1)}:${event.seq}`, {
      id: `event:${path.split("/").at(-1)}:${event.seq}`, kind: system ? "system" : "diagnostic",
      at: event.at, title: event.type, text: readable(data), data: structuredText(readable(data)) as Record<string, unknown>,
      ...provenance(event),
      status: failed ? "error" : "complete",
    });
  }
  return [...blocks.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export async function getActivity(project: string, run: string, epoch?: string) {
  const { path, manifest, events } = await loadRun(project, run);
  const started = performance.now();
  const selected = selectRunEvents(manifest, events, epoch).events;
  const blocks = await activityBlocks(path, selected);
  const latest = selected.at(-1);
  return { blocks, projection: { source: { component: "dashboard" }, throughSeq: latest?.seq ?? 0,
    latestEventAt: latest?.at ?? null, latestSourceAt: latest?.origin?.at ?? latest?.at ?? null,
    generatedAt: new Date().toISOString(), durationMs: performance.now() - started, blockCount: blocks.length } };
}
