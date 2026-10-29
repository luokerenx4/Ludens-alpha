import type { Capabilities, Clock } from "../contracts.ts";
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
  if (!entry) throw new Error(`Driver ${JSON.stringify(id)} is not built in. Select its package with --driver-package <spec>. Built-in drivers: ${driverIds().join(", ")}.`);
  return entry;
}

// Emulator implementations are optional external packages; only desktop CUA is built in.
registerDriver({ id: "cua", transport: "stdio",
  launchHint: "Starts the installed Cua Driver (cua-driver by default); it needs no emulator or bridge port.",
  load: options => createCuaProvider({ command: options.command, clock: options.clock }) });
