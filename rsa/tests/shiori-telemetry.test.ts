import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoop, type AgentLoopConfig, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import * as z from "@oh-my-pi/omptype/zod";
import { EventLog } from "../src/harness/events.ts";
import { ModelTrace } from "../src/harness/omp/trace.ts";

test("native Shiori runs preserve tool errors, aborted chats and thrown provider failures within one epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-shiori-native-"));
  const log = new EventLog(directory, {id: "native-fixture", now: () => performance.now()});
  const trace = new ModelTrace(log, () => ({epoch: "same-takeover"}));
  const model = getBundledModels("deepseek").find(m => m.id === "deepseek-flash")!;
  // Real Mario Maker calls were rejected for 201–216 character intent labels.
  const intent = "Inspect the current screen and use the workspace action helper to continue ".repeat(4).trim();
  let executedArgs: unknown;
  const config: AgentLoopConfig = {model, sessionId: "same-session", telemetry: trace.shiori.config,
    intentTracing: true, convertToLlm: messages => messages as Message[]};
  const tool: AgentTool = {name: "probe", label: "Probe", description: "Offline failure fixture", parameters: z.object({value: z.string()}),
    async execute(toolCallId, args) {
      executedArgs = args;
      log.record("fixture_execute", {}, trace.current(toolCallId));
      throw new Error("fixture tool failed");
    }};
  let invocation = 0;
  const message = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
    usage: {input: 10, output: 2, cacheRead: 4, cacheWrite: 0, totalTokens: 16,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
  });
  const complete = (result: AssistantMessage) => {
    const stream = new AssistantMessageEventStream();
    if (result.stopReason === "aborted" || result.stopReason === "error") stream.push({type: "error", reason: result.stopReason, error: result});
    else stream.push({type: "done", reason: result.stopReason, message: result});
    return stream;
  };
  const run = (streamFn: Parameters<ModelTrace["wrap"]>[0]) => agentLoop(
    [{role: "user", content: "offline fixture", timestamp: Date.now()}],
    {systemPrompt: ["Offline only"], messages: [], tools: [tool]}, config, undefined, trace.wrap(streamFn),
  ).result();
  try {
    await run(async () => complete(++invocation === 1
      ? message("toolUse", [{type: "toolCall", id: "probe-call", name: "probe", arguments: {value: "fixture payload", i: intent}}])
      : message("stop", [{type: "text", text: "done"}])));
    await run(async () => complete(message("aborted", [])));
    await expect(run(async () => { throw new Error("fixture provider failed"); })).rejects.toThrow("fixture provider failed");
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const starts = events.filter(e => e.type === "shiori_span_start");
    const ends = events.filter(e => e.type === "shiori_span_end");
    const roots = starts.filter(e => e.data.operation === "invoke_agent");
    const summaries = events.filter(e => e.type === "shiori_run_end");
    expect(roots).toHaveLength(3);
    expect(new Set(roots.map(e => e.trace.traceId)).size).toBe(3);
    expect(summaries.map(e => e.trace.spanId)).toEqual(roots.map(e => e.trace.spanId));
    expect(summaries.every(e => e.trace.epoch === "same-takeover")).toBe(true);
    expect(ends).toHaveLength(starts.length);
    expect(summaries[0].data.summary.tools).toMatchObject({total: 1, error: 1});
    const toolEnd = ends.find(e => e.data.operation === "execute_tool");
    expect(executedArgs).toEqual({value: "fixture payload"});
    expect(toolEnd.data.attributes["omp.gen_ai.tool.call.intent"]).toBe(intent);
    expect(toolEnd.data).toMatchObject({outcome: "error", status: {code: 2}, attributes: {"omp.gen_ai.tool.status": "error"}});
    expect(events.find(e => e.type === "fixture_execute").trace.spanId).toBe(toolEnd.trace.spanId);
    expect(ends.find(e => e.data.operation === "chat" && e.trace.traceId === roots[1].trace.traceId).data.outcome).toBe("cancelled");
    expect(ends.find(e => e.trace.spanId === roots[2].trace.spanId).data.outcome).toBe("error");
    expect(summaries[2].data.summary.chats).toMatchObject({total: 1, byStopReason: {error: 1}});
    expect(events.filter(e => e.type === "shiori_telemetry_warning")).toHaveLength(0);
  } finally { await trace.shiori.close(); await rm(directory, {recursive: true, force: true}); }
});
