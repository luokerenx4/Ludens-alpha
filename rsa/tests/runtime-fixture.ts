import { BasewareCore } from "@playness/baseware/core";
import type { Capabilities, ExecutionResult, Observation } from "@playness/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent } from "../src/harness/events.ts";
import { Runtime, type DeviceSession } from "../src/harness/runtime.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { WorkspaceController } from "../src/harness/controller.ts";

/** Exercise the production device core without a socket or a real device. */
export function createTestDeviceSession(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300) {
  const core = new BasewareCore({ capabilities, drivers: [{ id: "test", version: "1" }],
    record: (type, data, trace) => record(type, data, trace as EventTrace) });
  const client = { id: crypto.randomUUID() };
  const devices: DeviceSession = {
    catalog: core.list(),
    async acquire(epoch) { await core.acquire(epoch, maxSeconds, client); },
    async release(epoch) { await core.release(epoch); },
    execute: (id, argv, epoch, signal, trace, origin) => core.execute(id, argv, epoch, signal, { ...trace }, undefined, origin),
  };
  return { core, devices };
}

export function captureResult(observations: Observation[]): ExecutionResult {
  return { id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "", observations,
    timing: observations[0]?.timing ?? { clock: "test", requestedAtMs: 0, receivedAtMs: 1 } };
}

export function createTestRuntime(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300, runId?: string) {
  const { devices } = createTestDeviceSession(capabilities, record, maxSeconds);
  const runtime = new Runtime(devices, record, maxSeconds, runId);
  runtime.controller = new WorkspaceController({ workspace: process.cwd(), devices, record, env: {} });
  return runtime;
}

export async function readTestController(runtime: Runtime, id: string, argv: string[], signal: AbortSignal, trace: EventTrace = {}) {
  return await runtime.callController(`controller/${id}`, argv, undefined, signal, trace) as ExecutionResult;
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
  perception.observe = async (signal, parent = {}) => {
    const trace = childTrace(parent), started = performance.now();
    runtime.record("perception_observe_start", { status }, trace);
    signal.throwIfAborted();
    const result = await read(signal, trace);
    const value = { status, result, snapshot: { id: `snapshot-${++sequence}`, sequence,
      generation: status.generation, recordedAt: new Date().toISOString(),
      sampling: { clock: "test", startedAtMs: started, finishedAtMs: performance.now() },
      sampledAt: new Date().toISOString() }, reused: false };
    runtime.record("perception_observe_end", { ...value, outcome: "success", durationMs: performance.now() - started }, trace);
    return value;
  };
  runtime.perception = perception;
  return perception;
}
