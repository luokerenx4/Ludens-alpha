import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { activityBlocks, streamBlocks } from "../lib/activity";
import { selectCycle } from "../lib/aggregate";
import type { Event } from "../lib/types";

const anchor = { at: "2026-10-17T13:00:00.000Z", atMs: 0 };
// Both SSE and WS logs use this envelope; their raw transport annotations differ.
const frame = (value: Record<string, unknown>, atMs = 1) => JSON.stringify({ atMs, trace: { modelCallId: "model" }, event: {
  event: value.type ?? value.object, data: JSON.stringify(value), raw: [": ws ← event"],
} }) + "\n";
const event = (type: string, seq: number, data: Record<string, unknown> = {}, epoch = "cycle", toolCallId?: string): Event => ({
  seq, type, at: new Date(Date.parse(anchor.at) + seq).toISOString(), atMs: seq,
  trace: { epoch, modelCallId: "model", ...(toolCallId ? { toolCallId } : {}) }, data,
});

test("Responses delta, done and response snapshots produce one stable block per item", () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Check evidence." }], encrypted_content: "ENCRYPTED-SECRET" };
  const message = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Let's inspect." }] };
  const tool = { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", arguments: '{"command":"inspect"}' };
  const delta = { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Check ", sequence_number: 2 };
  const stream = [
    { type: "response.create", input: [{ role: "assistant", content: "OLD-HISTORY" }] },
    { type: "response.created", sequence_number: 0, response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", sequence_number: 1, item: { ...reasoning, summary: [] } },
    delta, delta, // The same sequence received/logged through both transports.
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "evidence.", sequence_number: 3 },
    { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "Check evidence.", sequence_number: 4 },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "Let's ", sequence_number: 5 },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "inspect.", sequence_number: 6 },
    { type: "response.output_text.done", item_id: "msg_1", content_index: 0, text: "Let's inspect.", sequence_number: 7 },
    { type: "response.output_item.added", item: { ...tool, arguments: "" }, sequence_number: 8 },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":', sequence_number: 9 },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"inspect"}', sequence_number: 10 },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: tool.arguments, sequence_number: 11 },
    { type: "response.output_item.done", item: tool, sequence_number: 12 },
    { type: "response.completed", sequence_number: 13, response: { id: "resp_1", output: [reasoning, message, tool] } },
  ].map((value, i) => frame(value, i)).join("");
  const blocks = streamBlocks(stream + '{"partial":', "model", anchor);
  assert.deepEqual(blocks.filter(b => b.kind !== "diagnostic").map(b => [b.id, b.text, b.status]), [
    ["model:thinking:rs_1:0", "Check evidence.", "complete"],
    ["model:text:msg_1:0", "Let's inspect.", "complete"],
    ["model:tool:call_1", '{\n  "command": "inspect"\n}', "complete"],
  ]);
  assert.equal(JSON.stringify(blocks).includes("OLD-HISTORY"), false);
  assert.equal(JSON.stringify(blocks).includes("ENCRYPTED-SECRET"), false);
  assert.equal(blocks.find(b => b.kind === "thinking")!.at, "2026-10-17T13:00:00.003Z");
  assert.deepEqual(blocks.find(b => b.kind === "tool")!.tool, { args: { command: "inspect" } });
  assert.deepEqual(blocks.find(b => b.title === "response.created")!.data,
    { type: "response.created", sequence_number: 0, response: { id: "resp_1", status: "in_progress" } });
});

test("partial tool arguments stay source text until they form JSON", () => {
  const start = frame({ type: "response.output_item.added", item: {
    type: "function_call", id: "fc", call_id: "call", name: "exec", arguments: "",
  } });
  const partial = start + frame({ type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"command":' });
  assert.deepEqual(streamBlocks(partial, "model", anchor)[0].tool, { args: '{"command":' });
  const complete = partial + frame({ type: "response.function_call_arguments.delta", item_id: "fc", delta: '"inspect"}' });
  assert.deepEqual(streamBlocks(complete, "model", anchor)[0].tool, { args: { command: "inspect" } });
});

test("activity blocks retain fact provenance and stream blocks link to their model anchor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-provenance-")));
  try {
    await mkdir(join(root, "streams"));
    const source = { component: "shiori", implementation: "omp", implementationVersion: "18.9.1" };
    const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16), modelCallId: "model" };
    const origin = { eventId: "host:1", clockId: "host", seq: 1, at: anchor.at, atMs: 0 };
    const start = { ...event("model_start", 1), source, trace, origin };
    await writeFile(join(root, "streams/model.jsonl"), frame({ type: "response.output_text.delta", item_id: "message", delta: "Hello" }));
    const blocks = await activityBlocks(root, [start]);
    for (const block of blocks) {
      assert.deepEqual(block.source, source);
      assert.deepEqual(block.trace, trace);
      assert.equal(block.eventId, origin.eventId);
      assert.equal(block.seq, 1);
      assert.ok(block.updatedAt);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DeepSeek chat chunks retain readable thinking, assistant text and function arguments", () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => frame({
    id: "deepseek-response", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
  });
  const blocks = streamBlocks([
    chunk({ role: "assistant", content: null, reasoning_content: "Now " }),
    chunk({ reasoning_content: "inspect the record." }),
    chunk({ content: "Opening " }), chunk({ content: "the record." }),
    chunk({ tool_calls: [{ index: 0, id: "call_deep", function: { name: "exec", arguments: '{"command":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"open"}' } }] }), chunk({}, "tool_calls"),
  ].join(""), "model", anchor);
  assert.deepEqual(blocks.map(b => [b.kind, b.text, b.status]), [
    ["thinking", "Now inspect the record.", "complete"], ["text", "Opening the record.", "complete"],
    ["tool", '{\n  "command": "open"\n}', "complete"],
  ]);
  assert.deepEqual(streamBlocks(chunk({ content: "\n" }, "stop"), "model", anchor), []);
});

test("cached growing streams and native bash artifact results join the same provider call without exec events", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-activity-"));
  const root = await realpath(temporary);
  try {
    await mkdir(join(root, "streams")); await mkdir(join(root, "payloads"));
    const file = join(root, "streams/model.jsonl");
    await writeFile(file, frame({ type: "response.output_text.delta", item_id: "message", delta: "Hello" }));
    const events = [event("model_start", 0)];
    const first = await activityBlocks(root, events);
    assert.equal(first.find(b => b.kind === "text")?.status, "running");
    assert.deepEqual(await activityBlocks(root, events), first);
    await appendFile(file, frame({ type: "response.output_text.done", item_id: "message", text: "Hello there" }));
    const next = (await activityBlocks(root, events)).filter(b => b.kind === "text");
    assert.equal(next.length, 1); assert.equal(next[0].id, first.find(b => b.kind === "text")?.id);
    assert.equal(next[0].text, "Hello there"); assert.equal(next[0].status, "complete");
    await appendFile(file, frame({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' } }));
    const resultPath = `payloads/${"a".repeat(64)}.json.gz`;
    await writeFile(join(root, resultPath), gzipSync(JSON.stringify({ content: [
      { type: "text", text: '{"stdout":"result.txt","exitCode":0}' }, { type: "image", mimeType: "image/png", data: "IMAGE-BASE64" },
    ] })));
    events.push(event("tool_start", 1, { toolName: "bash", args: { command: "ls" }, intent: "List files" }, "cycle", "call_1|fc_1"));
    events.push(event("tool_update", 2, { toolName: "bash",
      result: { content: [{ type: "text", text: "reading files…" }] } }, "cycle", "call_1|fc_1"));
    const progress = (await activityBlocks(root, events)).filter(b => b.kind === "tool");
    assert.equal(progress.length, 1); assert.equal(progress[0].status, "running");
    assert.equal(progress[0].tool?.result, "reading files…");
    events.push(event("tool_end", 3, { toolName: "bash", isError: false, result: { path: resultPath } }, "cycle", "call_1|fc_1"));
    const tools = (await activityBlocks(root, events)).filter(b => b.kind === "tool");
    assert.equal(tools.length, 1); assert.equal(tools[0].status, "complete");
    assert.equal(tools[0].title, "bash");
    assert.match(tools[0].text, /List files/); assert.match(tools[0].text, /result.txt/);
    assert.deepEqual(tools[0].tool, { intent: "List files", args: { command: "ls" }, result: { stdout: "result.txt", exitCode: 0 } });
    assert.equal(JSON.stringify(tools[0]).includes("IMAGE-BASE64"), false);
    await assert.rejects(activityBlocks(root, [{ ...events[0], trace: { modelCallId: "../escape" } }]), /调用 ID/);
    await symlink(file, join(root, "streams/alias.jsonl"));
    await assert.rejects(activityBlocks(root, [{ ...events[0], trace: { modelCallId: "alias" } }]), /运行目录/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("system and diagnostic blocks preserve structured event data with the existing redactions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-activity-data-"));
  const root = await realpath(temporary);
  try {
    const blocks = await activityBlocks(root, [
      event("control", 1, { mode: "manual", reason: "budget" }),
      event("model_http_end", 2, { elapsedMs: 123, status: 200, signature: "HIDDEN-SIGNATURE",
        observation: { type: "image", mimeType: "image/png", data: "IMAGE-BASE64" } }),
      event("background_result", 3, { kind: "job", jobId: "job-one", status: "completed", isError: false }),
    ]);
    assert.deepEqual(blocks.map(block => [block.kind, block.data]), [
      ["system", { mode: "manual", reason: "budget" }],
      ["diagnostic", { elapsedMs: 123, status: 200, observation: { type: "image", mimeType: "image/png" } }],
      ["system", { kind: "job", jobId: "job-one", status: "completed", isError: false }],
    ]);
    assert.equal(JSON.stringify(blocks).includes("HIDDEN-SIGNATURE"), false);
    assert.equal(JSON.stringify(blocks).includes("IMAGE-BASE64"), false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("action worker lifecycle reports failure once while fault detail and continuous statistics remain diagnostic", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-action-activity-")));
  try {
    const blocks = await activityBlocks(root, [
      event("action_status", 1, { state: "ready", generation: "first" }),
      event("action_stats", 2, { generation: "first", step: { completed: 150 } }),
      event("action_fault", 3, { generation: "first", error: "Step failed" }),
      event("action_status", 4, { state: "error", generation: "first", error: "Step failed" }),
      event("action_fault_end", 5, { generation: "first", reason: "stopped" }),
      event("action_status", 6, { state: "stopped", generation: "first" }),
    ]);
    assert.deepEqual(blocks.map(block => [block.title, block.kind, block.status]), [
      ["action_status", "system", "complete"], ["action_stats", "diagnostic", "complete"],
      ["action_fault", "diagnostic", "error"], ["action_status", "system", "error"],
      ["action_fault_end", "diagnostic", "complete"], ["action_status", "system", "complete"],
    ]);
    assert.deepEqual(blocks[1].data?.step, { completed: 150 }, "statistics remain available for inspection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cycle selection keeps other epochs' blocks out and rejects unknown epochs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-activity-epoch-"));
  const root = await realpath(temporary);
  try {
    const events = [event("control", 1, { mode: "auto" }, "old"), event("observation", 2, { id: "old-image" }, "old"),
      event("control", 3, { mode: "auto" }, "new"), event("observation", 4, { id: "new-image" }, "new")];
    const latest = await activityBlocks(root, selectCycle(events).events);
    assert.equal(latest.length, 2); assert.equal(JSON.stringify(latest).includes("old-image"), false);
    assert.throws(() => selectCycle(events, "missing"), /所选周期/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("explicit failed outcomes are visible system blocks while cancellations remain non-errors", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-activity-outcome-")));
  try {
    const events = ["capability_end", "shiori_span_end", "python_capabilities"]
      .map((type, index) => event(type, index + 1, { outcome: "error", error: "fixture failed" }));
    events.push(event("capability_end", 4, { outcome: "cancelled" }),
      event("execution_error", 5, { outcome: "cancelled", isError: true, stopReason: "error" }));
    const blocks = await activityBlocks(root, events);
    assert.deepEqual(blocks.map(block => [block.kind, block.status]), [
      ["system", "error"], ["system", "error"], ["system", "error"],
      ["diagnostic", "complete"], ["diagnostic", "complete"],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Python raises are diagnostics grouped only by explicit parents, while command failures remain visible", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-raised-")));
  try {
    const local = (type: string, seq: number, spanId: string, parentSpanId?: string, outcome?: string): Event => ({
      ...event(type, seq, { id: `python/actions.py:${spanId}`, ...(outcome ? { outcome, error: outcome === "error" ? "Pause did not stabilize" : undefined } : {}) }),
      trace: { epoch: "cycle", traceId: "python-trace", spanId, ...(parentSpanId ? { parentSpanId } : {}) },
    });
    const events = [local("python_call_start", 1, "outer"), local("python_call_start", 2, "inner", "outer"),
      local("python_call_end", 3, "inner", "outer", "error"), local("python_call_end", 4, "outer", undefined, "error"),
      local("python_call_start", 5, "caught"), local("python_call_start", 6, "negative-test", "caught"),
      local("python_call_end", 7, "negative-test", "caught", "error"), local("python_call_end", 8, "caught", undefined, "success"),
      event("tool_start", 9, { toolName: "bash", args: { command: "tests" } }, "cycle", "test"),
      event("tool_end", 10, { toolName: "bash", isError: false }, "cycle", "test"),
      event("background_result", 11, { jobId: "actual-failure", status: "failed", isError: true })];
    const blocks = await activityBlocks(root, events);
    const groups = blocks.filter(block => block.id.startsWith("python:"));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(block => [block.data?.calls, block.data?.raised, block.data?.rootOutcome]), [[2, 2, "error"], [2, 1, "success"]]);
    assert.ok(groups.every(block => block.kind === "diagnostic" && block.outcome === "raised"));
    assert.equal(blocks.filter(block => block.title === "python_call_end").length, 4, "raw events are still searchable");
    assert.ok(blocks.filter(block => block.title === "python_call_end").every(block => block.status !== "error"));
    assert.equal(blocks.find(block => block.kind === "tool")?.status, "complete", "caught exceptions do not override the test runner result");
    assert.equal(blocks.find(block => block.title === "background_result")?.status, "error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("assessment failure is distinct from execution/report errors and missing verdict stays unknown", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsa-assessment-")));
  try {
    const blocks = await activityBlocks(root, [
      event("benchmark_report", 1, { executionStatus: "completed", reportStatus: "valid", verdict: "failed" }),
      event("benchmark_end", 2, { executionStatus: "error", reportStatus: "missing", verdict: null }),
      event("benchmark_report", 3, { executionStatus: "completed", reportStatus: "invalid", verdict: null }),
      event("benchmark_report", 4, { valid: true }),
    ]);
    assert.deepEqual(blocks.map(block => [block.kind, block.status, block.outcome]), [
      ["system", "complete", "unmet"], ["system", "error", undefined], ["system", "error", undefined], ["system", "complete", undefined],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("model cancellation closes partial output without inventing a failure or completing an executing tool", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-activity-abort-"));
  const root = await realpath(temporary);
  try {
    await mkdir(join(root, "streams"));
    await writeFile(join(root, "streams/model.jsonl"), [
      { type: "response.reasoning_summary_text.delta", item_id: "rs", delta: "Inspect" },
      { type: "response.output_text.delta", item_id: "msg", delta: "Opening" },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "exec", arguments: "" } },
    ].map(value => frame(value)).join(""));
    const events = [event("model_start", 0), event("model_http_error", 1, { aborted: true, error: "cancelled" }),
      event("model_end", 2, { stopReason: "aborted" })];
    const stopped = await activityBlocks(root, events);
    assert.ok(stopped.every(block => block.status === "complete"));
    events.push(event("tool_start", 3, { toolName: "exec", args: { command: "pending" } }, "cycle", "call|fc"));
    const executing = await activityBlocks(root, events);
    assert.equal(executing.find(block => block.kind === "tool")?.status, "running");
    assert.ok(executing.filter(block => ["thinking", "text"].includes(block.kind)).every(block => block.status === "complete"));
    const failed = await activityBlocks(root, [events[0], event("model_end", 2, { stopReason: "error" })]);
    assert.ok(failed.filter(block => ["thinking", "text", "tool"].includes(block.kind)).every(block => block.status === "error"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("mixed WS/SSE runs merge tools and readable summaries without inventing assistant text", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rsa-activity-mixed-"));
  const root = await realpath(temporary);
  try {
    await mkdir(join(root, "streams"));
    const events: Event[] = [];
    for (const transport of ["ws", "http"]) {
      const modelEvent = (type: string, data = {}, toolCallId?: string) => {
        const entry = event(type, events.length, data, "cycle", toolCallId);
        entry.trace.modelCallId = transport;
        events.push(entry);
      };
      const tool = { type: "function_call", id: "fc", call_id: "call", name: "exec", arguments: '{"command":"inspect"}' };
      const output = transport === "ws"
        ? [{ type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "Inspect the scene." }] }, tool]
        : [tool];
      await writeFile(join(root, `streams/${transport}.jsonl`), [
        frame({ type: "response.output_item.done", item: tool }),
        frame({ type: "response.completed", response: { id: transport, output } }),
      ].join(""));
      modelEvent("model_start");
      modelEvent(`model_${transport}_dispatch`);
      modelEvent("model_end", { stopReason: "toolUse" });
      modelEvent("tool_start", { toolName: "exec", args: { command: "inspect" } }, "call|fc");
      modelEvent("exec_result", { stdout: "fixture result", exitCode: 0 }, "call|fc");
      modelEvent("tool_end", { toolName: "exec", isError: false }, "call|fc");
    }
    const blocks = await activityBlocks(root, events);
    assert.equal(blocks.filter(b => b.kind === "tool").length, 2);
    assert.equal(blocks.filter(b => b.kind === "thinking").length, 1);
    assert.equal(blocks.filter(b => b.kind === "text").length, 0);
    assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length);
    assert.ok(blocks.filter(b => b.kind === "tool").every(b => b.text.includes("结果：")));
    assert.ok(blocks.some(b => b.kind === "diagnostic" && b.title === "model_ws_dispatch"));
    assert.ok(blocks.some(b => b.kind === "diagnostic" && b.title === "model_http_dispatch"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
