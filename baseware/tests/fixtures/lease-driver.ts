import { Bridge } from "../../src/drivers/bridge.ts";
import type { DriverRegistration } from "../../src/drivers/registry.ts";

/** External protocol fixture for host lifecycle tests; no emulator implementation. */
export default {
  id: "lease-fixture",
  transport: "bridge",
  async load({ port, clock }) {
    const bridge = await Bridge.open(port!);
    await bridge.request("HELLO");
    let owner: string | undefined;
    return {
      capabilities: { controllers: [{
        tool: { name: "fixture.noop", inputSchema: { type: "object" } },
        requiresControl: true,
        async acquire(epoch: string) {
          if (owner === epoch) return;
          await bridge.request("OWN", [epoch]); owner = epoch;
        },
        async release(epoch: string) {
          if (owner !== epoch) return;
          owner = undefined; await bridge.request("DISOWN", [epoch]);
        },
        async execute() {
          const now = clock.now();
          return { id: crypto.randomUUID(), status: "completed" as const, exitCode: 0,
            stdout: "", stderr: "", result: { content: [] },
            timing: { clock: clock.id, requestedAtMs: now, receivedAtMs: now } };
        },
      }] },
      onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
      close() { bridge.close(); },
    };
  },
} satisfies DriverRegistration;
