import type { Clock } from "../../contracts.ts";
import { Bridge } from "../bridge.ts";
import { createCuaProvider } from "../cua/provider.ts";
import { createTouchController } from "../touch.ts";

/** Native touch with the existing desktop channels for observation and keyboard. */
export async function createAzaharProvider(options: {
  port: number; artifactsDir: string; clock: Clock; cuaCommand?: string;
}) {
  const bridge = await Bridge.open(options.port);
  let desktop: Awaited<ReturnType<typeof createCuaProvider>> | undefined;
  try {
    const [version] = await bridge.request("HELLO");
    if (version !== "azahar-rsa-1") throw new Error(`Unexpected bridge: ${version}`);
    let owner: string | undefined;
    const acquire = async (epoch: string) => {
      if (owner === epoch) return;
      await bridge.request("OWN", [epoch]); owner = epoch;
    };
    const release = async (epoch: string) => {
      if (owner !== epoch) return;
      owner = undefined;
      await bridge.request("DISOWN", [epoch]);
    };
    const touch = await createTouchController({ bridge, clock: options.clock, acquire, release,
      owns: epoch => owner === epoch });
    desktop = await createCuaProvider({ command: options.cuaCommand, artifactsDir: options.artifactsDir, clock: options.clock });
    return {
      capabilities: { controllers: [touch, ...desktop.capabilities.controllers] },
      drivers: [{ id: "azahar", version: "2126.2-rsa.1" }, { id: "cua", version: desktop.version }],
      onDisconnect(handler: (error: Error) => void) {
        bridge.onDisconnect = handler;
        desktop!.onDisconnect(handler);
      },
      async close() { bridge.close(); await desktop!.close(); },
    };
  } catch (error) {
    bridge.close(); await desktop?.close(); throw error;
  }
}
