import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { EventLog } from "../src/harness/events.ts";
import { ModelTrace } from "../src/harness/omp/trace.ts";

test("native background deliveries retain launch traces across turns and reused service names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-native-background-"));
  const log = new EventLog(directory, { id: "background-fixture", now: () => performance.now() });
  let epoch = "first";
  const trace = new ModelTrace(log, () => ({ epoch }));
  let emit: Parameters<AgentSession["subscribe"]>[0];
  const noRequest = new Error("offline trace boundary");
  const session = {
    agent: { streamFn: async () => { throw noRequest; } },
    subscribe(listener: typeof emit) { emit = listener; return () => {}; },
  } as unknown as AgentSession;
  const detach = trace.attach(session);
  const model = getBundledModels("deepseek").find(item => item.id === "deepseek-flash")!;
  const turn = async () => {
    await expect(session.agent.streamFn!(model, { messages: [] })).rejects.toBe(noRequest);
    return trace.current();
  };
  const start = (id: string, details: unknown) => emit!({
    type: "tool_execution_end", toolName: "bash", toolCallId: id, isError: false,
    result: { content: [{ type: "text", text: "native launch result" }], details },
  });
  const delivered = (customType: string, details: unknown) => emit!({
    type: "message_end", message: { role: "custom", customType, content: "native result body",
      details, display: true, timestamp: Date.now() },
  });
  try {
    const first = await turn();
    start("job-first", { async: { jobId: "job-one", type: "bash", state: "running" } });
    start("service-first", { service: { name: "worker", pid: 101, state: "running" } });
    epoch = "second";
    const second = await turn();
    start("job-second", { async: { jobId: "job-two", type: "bash", state: "running" } });
    start("service-second", { service: { name: "worker", pid: 202, state: "ready" } });
    start("suppressed", { async: { jobId: "suppressed", type: "bash", state: "running" } });
    epoch = "third";
    await turn();
    delivered("async-result", { jobs: [
      { jobId: "job-one", type: "bash", status: "completed", durationMs: 100 },
      { jobId: "job-two", type: "bash", status: "failed", durationMs: 200 },
      { jobId: "unobserved-launch", type: "bash", status: "completed" },
    ] });
    delivered("launch-completion", { daemons: [
      { name: "worker", pid: 101, state: "exited", exitCode: 0 },
      { name: "worker", pid: 202, state: "failed", exitCode: 1 },
      { name: "worker", pid: 303, state: "exited", exitCode: 0 },
    ] });
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const starts = events.filter(event => event.type === "background_start");
    const results = events.filter(event => event.type === "background_result");
    expect(starts).toHaveLength(5);
    expect(results).toHaveLength(6); // No invented completion for the suppressed job.
    for (const [index, original, toolCallId] of [
      [0, first, "job-first"], [1, second, "job-second"],
      [3, first, "service-first"], [4, second, "service-second"],
    ] as const) {
      const startEvent = starts.find(event => event.trace.toolCallId === toolCallId);
      expect(startEvent.trace).toMatchObject({ epoch: original.epoch, modelCallId: original.modelCallId, toolCallId });
      expect(results[index].trace).toEqual(startEvent.trace);
      expect(results[index].source.component).toBe("shiori");
    }
    expect(results[2].trace).toEqual({});
    expect(results[5].trace).toEqual({}); // Same service name does not authorize PID guessing.
    expect(results.map(event => event.data.isError)).toEqual([false, true, false, false, true, false]);
    const payload = JSON.parse(gunzipSync(await readFile(join(directory, results[0].data.result.path))).toString());
    expect(payload).toMatchObject({ role: "custom", customType: "async-result", content: "native result body" });
    expect(events.some(event => event.type === "exec" || event.type === "exec_result")).toBe(false);
  } finally {
    detach();
    await trace.shiori.close();
    await rm(directory, { recursive: true, force: true });
  }
});
