import { BasewareCore } from "@playness/baseware/core";
import type { Capabilities } from "@playness/baseware/contracts";
import type { EventTrace, RecordEvent } from "../src/harness/events.ts";
import { Runtime, type DeviceOperations } from "../src/harness/runtime.ts";

/** Exercise the production device core without a socket or a real device. */
export function createTestRuntime(capabilities: Capabilities, record: RecordEvent = () => {}, maxSeconds = 300, runId?: string) {
  const core = new BasewareCore({ capabilities, drivers: [{ id: "test", version: "1" }],
    record: (type, data, trace) => record(type, data, trace as EventTrace) });
  let epoch: string | undefined;
  const client = { id: crypto.randomUUID() };
  const acquire = async (next: string) => {
    if (epoch === next) return;
    await core.acquire(next, maxSeconds, client);
    epoch = next;
  };
  const release = async (previous: string) => {
    if (epoch !== previous) return;
    epoch = undefined;
    await core.release(previous);
  };
  const operations: DeviceOperations = {
    observe: (request, signal, trace, origin) => core.observe(request, signal, { ...trace }, origin),
    execute: (id, argv, owner, signal, trace) => core.execute(id, argv, owner, signal, { ...trace }),
  };
  return new Runtime({ sensors: capabilities.sensors,
    controllers: capabilities.controllers.map(controller => ({ ...controller, acquire, release })) },
  record, operations, maxSeconds, runId);
}
