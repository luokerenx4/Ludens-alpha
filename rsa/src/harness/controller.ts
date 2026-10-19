import type { EventTrace, RecordEvent } from "./events.ts";
import { PythonCapabilities, type PythonCapability } from "./python-capabilities.ts";
import type { DeviceSession } from "./runtime.ts";

interface ControllerOptions {
  workspace: string;
  devices: DeviceSession;
  env: NodeJS.ProcessEnv;
  record: RecordEvent;
}

export interface CapabilityContext {
  epoch?: string;
  signal: AbortSignal;
  trace: EventTrace;
}

const pythonId = (capability: PythonCapability) => `python/${capability.origin.path}:${capability.origin.function}`;
const summary = (description: string) => description.trim().split("\n")[0] ?? "";

/** The workspace's CLI/API catalog; discovery does not register model tools. */
export class WorkspaceController {
  private readonly python: PythonCapabilities;

  constructor(private readonly options: ControllerOptions) {
    this.python = new PythonCapabilities(options.workspace, options.env.RSA_PYTHON, options.record);
  }

  async list(signal: AbortSignal, trace: EventTrace = {}) {
    const discovered = await this.python.discover(signal, trace);
    const { controllers } = this.options.devices.catalog;
    return {
      capabilities: [
        ...controllers.map(item => ({ id: `controller/${item.id}`, description: summary(item.help),
          requiresControl: item.requiresControl, ...(item.mediaTypes?.length ? { mediaTypes: item.mediaTypes } : {}) })),
        ...discovered.capabilities.map(item => ({ id: pythonId(item), description: summary(item.description),
          ...(item.hook ? { hook: item.hook } : {}) })),
      ],
      diagnostics: discovered.diagnostics,
    };
  }

  async help(id: string, signal: AbortSignal, trace: EventTrace = {}): Promise<string> {
    signal.throwIfAborted();
    const device = this.device(id);
    if (device) {
      const help = device.help.replaceAll(`baseware controller ${device.id}`, `rsa controller ${id}`);
      return `Usage: rsa controller ${id} <arguments...>\n\n${help}`;
    }
    const capability = await this.pythonCapability(id, signal, trace);
    return JSON.stringify({ id, usage: `rsa controller ${id} --args '<JSON object>'`,
      description: capability.description, parameters: capability.parameters,
      ...(capability.hook ? { hook: capability.hook, returns: { text: "optional string", media: [{ path: "local file path", mediaType: "MIME type" }] } } : {}) }, null, 2);
  }

  async call(id: string, args: unknown, context: CapabilityContext): Promise<unknown> {
    const { signal, trace, epoch } = context;
    signal.throwIfAborted();
    const device = this.device(id);
    if (device) {
      const argv = args === undefined ? [] : args;
      if (!Array.isArray(argv) || !argv.every(item => typeof item === "string")) {
        throw new TypeError("Driver capability arguments must be an array of strings");
      }
      return this.options.devices.execute(device.id, argv, epoch, signal, trace, "cli");
    }
    const capability = await this.pythonCapability(id, signal, trace);
    const result = await this.python.invoke(capability.id, args === undefined ? {} : args, {
      signal, invocationTrace: trace.spanId ? trace : undefined, env: { ...this.options.env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(trace) },
    });
    if (result.isError) throw new Error(`${result.details.error?.type ?? "PythonError"}: ${result.details.error?.message ?? "Capability failed"}`);
    return result.details.result;
  }

  private device(id: string) {
    return this.options.devices.catalog.controllers.find(item => id === `controller/${item.id}`);
  }

  requiresControl(id: string) { return this.device(id)?.requiresControl ?? true; }

  private async pythonCapability(id: string, signal: AbortSignal, trace: EventTrace): Promise<PythonCapability> {
    if (id.startsWith("python/")) {
      const discovered = await this.python.discover(signal, trace);
      const capability = discovered.capabilities.find(item => pythonId(item) === id);
      if (capability) return capability;
      const diagnostic = discovered.diagnostics.find(item => id.startsWith(`python/${item.path}:`));
      if (diagnostic) throw new Error(`Invalid capability ${id}: ${diagnostic.message}`);
    }
    throw new Error(`Unknown capability: ${id}; use rsa controller list`);
  }
}
