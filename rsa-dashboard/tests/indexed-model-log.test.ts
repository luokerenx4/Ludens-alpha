import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonArchive } from "../../shared/log-archive";
import { activityBlocks, refreshActivity, queryActivity } from "../lib/activity";
import { closeLogIndexes, getLogIndex } from "../lib/log-index";
import { openRun } from "../lib/data";
import type { Event } from "../lib/types";

const scope = { project: "test", runId: "run", epoch: "cycle" };
const event = (seq: number, type: string, data: Record<string, unknown> = {}, toolCallId?: string): Event => ({
  seq, type, at: new Date(Date.UTC(2026, 9, 27, 0, 0, seq)).toISOString(), atMs: seq * 1000,
  data, trace: { epoch: "cycle", modelCallId: "model", ...(toolCallId ? { toolCallId } : {}) },
});
const row = (value: any, atMs = 1000) => JSON.stringify({ atMs, event: {
  event: value.type, data: JSON.stringify(value), raw: [": fixture", `data: ${JSON.stringify(value)}`],
} }) + "\n";
const referenced = (archive: JsonArchive, value: any, atMs = 1000) => JSON.stringify({ format: "rsa-stream-v1", atMs,
  event: { event: value.type, dataRef: archive.write(value, { inline: true }), dataFormat: "json", raw: [": fixture", { data: true, prefix: "data: " }] },
}) + "\n";
async function fixture(work: (workspace: string, run: string, archive: JsonArchive) => Promise<void>) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-log-ref-")));
  const run = join(workspace, "logs", "run");
  try {
    await mkdir(join(run, "streams"), { recursive: true });
    await writeFile(join(run, "manifest.json"), JSON.stringify({ workspace }));
    await work(workspace, run, new JsonArchive(workspace));
  } finally { await closeLogIndexes(); await rm(workspace, { recursive: true, force: true }); }
}

// A nonexistent outgoing object proves that request history is never hydrated.
const outgoing = JSON.stringify({ format: "rsa-stream-v1", atMs: 0, event: { event: "response.create",
  dataRef: { encoding: "rsa-json-v1", path: `objects/${"f".repeat(64)}.json.gz`, sha256: "f".repeat(64), bytes: 100000000 },
} }) + "\n";

test("reference streams and tool payloads preserve legacy activity, including arguments and late completion", async () => fixture(async (workspace, run, archive) => {
  const delta = { type: "response.output_text.delta", item_id: "message", delta: "Inspect evidence.", sequence_number: 1 };
  const done = { type: "response.output_text.done", item_id: "message", text: "Inspect evidence, then continue.", sequence_number: 2 };
  const args = { command: "python3 helper.py", timeout: 10 };
  const result = { content: [{ type: "text", text: '{"stdout":"finished","exitCode":0}' }], details: { exitCode: 0 } };
  const events = [event(1, "model_start"), event(2, "tool_start", { toolName: "bash", args }, "tool"),
    event(3, "tool_end", { toolName: "bash", result, isError: false }, "tool")];
  await writeFile(join(run, "streams/model.jsonl"), row(delta) + row(done, 2000));
  const expected = await activityBlocks(run, events);
  await writeFile(join(run, "streams/model.jsonl"), outgoing + referenced(archive, delta) + referenced(archive, done, 2000));
  const indexed = [events[0], event(2, "tool_start", { toolName: "bash", argsRef: archive.write(args) }, "tool"),
    event(3, "tool_end", { toolName: "bash", result: archive.write(result), isError: false }, "tool")];
  assert.deepEqual(await activityBlocks(run, indexed, workspace), expected);

  await writeFile(join(run, "streams/model.jsonl"), outgoing + referenced(archive, delta));
  await writeFile(join(run, "events.jsonl"), indexed.slice(0, 2).map(value => JSON.stringify(value)).join("\n") + "\n");
  const index = getLogIndex(run); index.archiveWorkspace = workspace;
  await refreshActivity(index);
  const first = await queryActivity(index, scope);
  assert.equal(first.blocks.find(block => block.kind === "text")?.text, delta.delta);
  assert.deepEqual(first.blocks.find(block => block.kind === "tool")?.tool?.args, args);
  await appendFile(join(run, "streams/model.jsonl"), referenced(archive, done, 2000));
  await appendFile(join(run, "events.jsonl"), JSON.stringify(indexed[2]) + "\n");
  await refreshActivity(index);
  const update = await queryActivity(index, scope, { cursor: first.cursor! });
  assert.equal(update.blocks.find(block => block.kind === "text")?.text, done.text);
  assert.deepEqual(update.blocks.find(block => block.kind === "tool")?.tool?.result, { stdout: "finished", exitCode: 0 });
  assert.equal(update.blocks.find(block => block.kind === "tool")?.status, "complete");
}));

test("activity keeps media references without reading media bytes or caching base64", async () => fixture(async (workspace, run, archive) => {
  const bytes = Buffer.from("recorded fixture pixels ".repeat(1000));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const object = join(workspace, ".rsa", "timeline", "objects", `${sha}.bin`);
  await mkdir(join(workspace, ".rsa", "timeline", "objects"), { recursive: true });
  await writeFile(object, bytes);
  const result = archive.write({ content: [
    { type: "text", text: "Look at this recorded frame." },
    { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
  ] });
  await rm(object); // An expired or offline medium must not break text projection.
  const events = [event(1, "model_start"), event(2, "tool_end", { toolName: "observe", result, isError: false }, "observe")];
  await writeFile(join(run, "streams/model.jsonl"), outgoing);
  await writeFile(join(run, "events.jsonl"), events.map(value => JSON.stringify(value)).join("\n") + "\n");
  const tool = (await activityBlocks(run, events, workspace)).find(block => block.kind === "tool")!;
  assert.match(tool.text, /Look at this recorded frame/);
  assert.match(tool.text, /\$media/); assert.match(tool.text, new RegExp(sha));
  assert.equal(tool.text.includes(bytes.toString("base64")), false);
  const index = getLogIndex(run); index.archiveWorkspace = workspace;
  await refreshActivity(index);
  assert.equal((await queryActivity(index, scope)).blocks.find(block => block.kind === "tool")?.text, tool.text);
  const files = await readdir(index.directory, { recursive: true });
  for (const file of files.filter(file => file.endsWith(".jsonl")))
    assert.equal((await readFile(join(index.directory, file), "utf8")).includes(bytes.toString("base64")), false);
}));

test("missing inbound objects fail explicitly; non-JSON and DONE stream frames remain consumable", async () => fixture(async (workspace, run, archive) => {
  const nonJson = (value: string) => JSON.stringify({ format: "rsa-stream-v1", event: {
    event: "transport.note", dataRef: archive.write(value, { inline: true }), dataFormat: "text", raw: [{ data: true, prefix: "data: " }],
  } }) + "\n";
  await writeFile(join(run, "streams/model.jsonl"), nonJson("plain provider notice") + nonJson("[DONE]"));
  assert.equal((await activityBlocks(run, [event(1, "model_start")], workspace)).filter(block => block.title === "transport.note").length, 1);
  await writeFile(join(run, "streams/model.jsonl"), outgoing.replace("response.create", "response.output_text.done"));
  await assert.rejects(activityBlocks(run, [event(1, "model_start")], workspace));
}));

test("Dashboard binds archives to the registered workspace and rejects a foreign manifest", async () => fixture(async (workspace, run) => {
  const root = join(workspace, "registered");
  const state = join(root, "test");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "workspace.json"), JSON.stringify({ workspace }));
  await writeFile(join(run, "events.jsonl"), "");
  const loaded = await openRun("test", "run", root);
  assert.equal(loaded.index.archiveWorkspace, workspace); loaded.release();
  const foreign = join(workspace, "foreign"); await mkdir(foreign);
  await writeFile(join(run, "manifest.json"), JSON.stringify({ workspace: foreign }));
  const mismatched = await openRun("test", "run", root);
  assert.equal(mismatched.index.archiveWorkspace, null); mismatched.release();
  const reference = new JsonArchive(workspace).write({ content: [{ type: "text", text: "private" }] });
  await assert.rejects(activityBlocks(run, [event(2, "tool_end", { toolName: "bash", result: reference }, "tool")], null));
}));

test("run projection indexes skill paths but keeps referenced arguments out of cached call bodies", async () => fixture(async (workspace, run, archive) => {
  const { refreshRunProjection, readRunProjection } = await import("../lib/run-index");
  const oldArgs = archive.write({ command: "old command " + "OLD-ARGUMENTS ".repeat(1000) });
  const source = "NEW-SKILL-SOURCE ".repeat(1000);
  const args = archive.write({ path: "skills/learned/SKILL.md", content: source });
  const values = [event(1, "model_start"), event(2, "tool_start", { toolName: "bash", argsRef: oldArgs }, "old"),
    event(3, "tool_end", { toolName: "bash", isError: false }, "old"), event(4, "model_end", { stopReason: "toolUse", durationMs: 1000 }),
    ...[event(5, "model_start"), event(6, "tool_start", { toolName: "write", argsRef: args }, "write"),
      event(7, "tool_end", { toolName: "write", isError: false }, "write")].map(value => ({ ...value, trace: { ...value.trace, modelCallId: "next" } }))];
  await writeFile(join(run, "events.jsonl"), values.map(value => JSON.stringify(value)).join("\n") + "\n");
  const index = getLogIndex(run); index.archiveWorkspace = workspace;
  await refreshRunProjection(index);
  const cached = index.store("run-calls").meta("next");
  assert.ok(cached);
  assert.equal(cached.file, undefined);
  assert.equal(JSON.stringify(cached).includes(source), false);
  await rm(join(workspace, ".rsa", "archive", oldArgs.path));
  const page = await readRunProjection(index, "cycle");
  assert.equal(page.summary.completed, 1);
  assert.equal(page.selectedCall?.id, "next");
  assert.equal(page.selectedCall?.tools[0].args.content, source);
  assert.ok(page.skills.some(skill => skill.path === "skills/learned/SKILL.md" && skill.ok === true));
  await assert.rejects(readRunProjection(index, "cycle", { call: "model" }), /ENOENT/);
}));
