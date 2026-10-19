import { BasewareCore } from "@playness/baseware/core";
import type { Capabilities } from "@playness/baseware/contracts";
import type { EventTrace, RecordEvent } from "../src/harness/events.ts";
import { Runtime, type DeviceSession } from "../src/harness/runtime.ts";

/** Exercise the production device core without a socket or a real device. */
export function createTestDeviceSession(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300) {
  const core = new BasewareCore({ capabilities, drivers: [{ id: "test", version: "1" }],
    record: (type, data, trace) => record(type, data, trace as EventTrace) });
  const client = { id: crypto.randomUUID() };
  const devices: DeviceSession = {
    catalog: core.list(),
    async acquire(epoch) { await core.acquire(epoch, maxSeconds, client); },
    async release(epoch) { await core.release(epoch); },
    observe: (request, signal, trace, origin) => core.observe(request, signal, { ...trace }, origin),
  };
  return { core, devices };
}

export function createTestRuntime(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300, runId?: string) {
  const { devices } = createTestDeviceSession(capabilities, record, maxSeconds);
  return new Runtime(devices, record, maxSeconds, runId);
}
