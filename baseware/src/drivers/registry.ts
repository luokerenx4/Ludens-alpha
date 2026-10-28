import type { Capabilities, Clock } from "../contracts.ts";
import { createGbaProvider } from "./mgba/provider.ts";
import { createSwitchProvider } from "./ryubing/provider.ts";
import { createAzaharProvider } from "./azahar/provider.ts";
import { createCuaProvider } from "./cua/provider.ts";

/** Runtime shape every driver (built-in or community) must satisfy. */
export interface DriverProvider {
  capabilities: Capabilities;
  version?: string;
  onDisconnect(handler: (error: Error) => void): void;
  close(): void | Promise<void>;
}

export interface DriverCreateOptions {
  port?: number;
  command?: string;
  clock: Clock;
}

export type DriverTransport = "bridge" | "stdio";

/** Static self-description every driver publishes; launchers read this instead of hardcoding drivers. */
export interface DriverManifest {
  id: string;
  version?: string;
  /** How Baseware reaches the device backend; defaults to bridge when defaultPort is set. */
  transport?: DriverTransport;
  /** Bridge port when the driver speaks the socket-bridge protocol; absent for stdio drivers. */
  defaultPort?: number;
  /** Whether the backend must start (with a game) before the bridge accepts connections. */
  needsGame?: boolean;
  /** Human-readable backend preparation hint, shown by launchers. */
  launchHint?: string;
  /** Backend executable argv (without the game path); game path is appended by the launcher. */
  launchCommand?: string[];
  /** Environment overrides required by the backend executable. */
  launchEnv?: Record<string, string>;
}
export interface DriverRegistration extends DriverManifest {
  /** Reported when the provider itself returns no version. */
  fallbackVersion?: string;
  load(options: DriverCreateOptions): Promise<DriverProvider>;
}

const registry = new Map<string, DriverRegistration>();

export function registerDriver(entry: DriverRegistration): void {
  if (registry.has(entry.id)) throw new Error(`Duplicate driver: ${entry.id}`);
  registry.set(entry.id, entry);
}

export function driverIds(): string[] {
  return [...registry.keys()];
}

export function getDriver(id: string): DriverRegistration {
  const entry = registry.get(id);
  if (!entry) throw new Error(`--driver must be one of: ${driverIds().join(", ")}`);
  return entry;
}

// Built-in drivers; community drivers will register via registerDriver instead of editing main.ts.
registerDriver({ id: "mgba", transport: "bridge", defaultPort: 47653, fallbackVersion: "0.10.5",
  launchHint: "Open the ROM in mGBA and load baseware/src/drivers/mgba/bridge.lua in Tools → Scripting.",
  load: options => createGbaProvider({ port: options.port!, clock: options.clock }) });
registerDriver({ id: "ryubing", transport: "bridge", defaultPort: 47663, needsGame: true, fallbackVersion: "1.3.351-rsa.3",
  launchHint: "Start the patched ryubing with the desired game, or set game in rsa.json.",
  launchCommand: ["/Applications/Ryubing.app/Contents/MacOS/Ryujinx"],
  launchEnv: { DOTNET_DefaultStackSize: "200000" },
  load: options => createSwitchProvider({ port: options.port!, clock: options.clock }) });
registerDriver({ id: "azahar", transport: "bridge", defaultPort: 47673, needsGame: true,
  launchHint: "Start the patched azahar with the desired game, or set game in rsa.json.",
  launchCommand: ["/Applications/Azahar.app/Contents/MacOS/azahar"],
  load: options => createAzaharProvider({ port: options.port!, clock: options.clock }) });
registerDriver({ id: "cua", transport: "stdio",
  launchHint: "Starts the installed Cua Driver (cua-driver by default); it needs no emulator or bridge port.",
  load: options => createCuaProvider({ command: options.command, clock: options.clock }) });
