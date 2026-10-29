import { BasewareCore } from "@ludens/baseware/core";
import type { Capabilities, ExecutionResult, Observation, ToolArguments, ToolExecutionResult } from "@ludens/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent } from "../src/harness/events.ts";
import { Runtime, type DeviceSession } from "../src/harness/runtime.ts";
import { PerceptionRuntime, perceptionMetadata, type PerceptionRead } from "../src/harness/perception.ts";
import { WorkspaceController } from "../src/harness/controller.ts";

/** Exercise the production device core without a socket or a real device. */
export function createTestDeviceSession(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300) {
  const core = new BasewareCore({ capabilities, drivers: [{ id: "test", version: "1" }],
    record: (type, data, trace) => record(type, data, trace as EventTrace) });
  const client = { id: crypto.randomUUID() };
  const devices: DeviceSession = {
    catalog: core.list(),
    async acquire(epoch, signal) { await core.acquire(epoch, maxSeconds, client, signal); },
    async release(epoch) { await core.release(epoch); },
    execute: (id, args, epoch, signal, trace, origin) => core.execute(id, args, epoch, signal, { ...trace }, undefined, origin),
  };
  return { core, devices };
}

export function captureResult(observations: Observation[]): ToolExecutionResult {
  return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "", result: { content: [] }, observations,
    timing: observations[0]?.timing ?? { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } };
}

export function createTestRuntime(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300, runId?: string) {
  const { devices } = createTestDeviceSession(capabilities, record, maxSeconds);
  const runtime = new Runtime(devices, record, maxSeconds, runId);
  runtime.controller = new WorkspaceController({ workspace: process.cwd(), devices, record, env: {} });
  return runtime;
}

export async function readTestController(runtime: Runtime, id: string, args: ToolArguments, signal: AbortSignal, trace: EventTrace = {}) {
  return await runtime.callController(`controller/${id}`, args, undefined, signal, trace) as ExecutionResult;
}

/** OMP history/telemetry tests supply perception results without starting Python.
 * The real resident process lifecycle is exercised by perception.test.ts. */
export function installTestPerception(
  runtime: Runtime,
  workspace: string,
  runDir: string,
  read: (signal: AbortSignal, trace: EventTrace) => Promise<ExecutionResult>,
) {
  const perception = new PerceptionRuntime({ workspace, runDir, record: runtime.record });
  const status = { state: "ready" as const, generation: "test-perception", codeSHA: "test-source" };
  let sequence = 0;
  perception.status = () => status;
  perception.observe = async (signal, parent = {}, query = {}) => {
    const trace = childTrace(parent), started = performance.now();
    const queryId = trace.spanId!;
    runtime.record("perception_observe_start", { queryId, query }, trace);
    signal.throwIfAborted();
    const result = await read(signal, trace);
    const value: PerceptionRead = { queryId, ok: result.exitCode === 0, query, hasMore: false,
      records: result.exitCode === 0 ? [{ id: `snapshot-${++sequence}`, sequence,
      generation: status.generation, capability: "python/perception.py:Perception.sample", recordedAt: new Date().toISOString(),
      sampling: { clock: "test", startedAtMs: started, finishedAtMs: performance.now() },
      sampledAt: new Date().toISOString(), text: result.stdout, media: result.observations ?? [] }] : [],
      ...(result.exitCode === 0 ? {} : { error: { code: "QUERY_FAILED", message: result.stderr || result.stdout } }) };
    runtime.record("perception_observe_end", { ...perceptionMetadata(value), outcome: value.ok ? "success" : "error",
      durationMs: performance.now() - started }, trace);
    return value;
  };
  runtime.perception = perception;
  return perception;
}
