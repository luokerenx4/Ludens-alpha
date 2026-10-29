import type { EventTrace, RecordEvent } from "./events.ts";
import { PythonCapabilities, type PythonCapability } from "./python-capabilities.ts";
import type { DeviceSession } from "./runtime.ts";
import { objectArguments } from "@ludens/baseware/tool-contract";

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
    this.python = new PythonCapabilities(options.workspace, options.env.RSA_PYTHON, options.record, options.env.RSA_LOG_DIAGNOSTICS === "full" ? "full" : "normal");
  }

  async list(signal: AbortSignal, trace: EventTrace = {}) {
    const discovered = await this.python.discover(signal, trace);
    const { controllers } = this.options.devices.catalog;
    return {
      capabilities: [
        ...controllers.map(item => ({ ...item, id: `controller/${item.name}` })),
        ...discovered.capabilities.map(item => ({ id: pythonId(item), description: summary(item.description),
          recorded: item.recorded ?? false })),
      ],
      diagnostics: discovered.diagnostics,
    };
  }

  async help(id: string, signal: AbortSignal, trace: EventTrace = {}): Promise<string> {
    signal.throwIfAborted();
    const device = this.device(id);
    if (device) {
      return JSON.stringify({ ...device, id, usage: `rsa controller ${id} [--args '<JSON object>' | --file <arguments.json>]` }, null, 2);
    }
    const capability = await this.pythonCapability(id, signal, trace);
    return JSON.stringify({ id, usage: `rsa controller ${id} --args '<JSON object>'`,
      description: capability.description, parameters: capability.parameters,
      recorded: capability.recorded ?? false,
    }, null, 2);
  }

  async call(id: string, args: unknown, context: CapabilityContext): Promise<unknown> {
    const { signal, trace, epoch } = context;
    signal.throwIfAborted();
    const device = this.device(id);
    if (device) {
      return this.options.devices.execute(device.name, objectArguments(args === undefined ? {} : args), epoch, signal, trace, "cli");
    }
    const capability = await this.pythonCapability(id, signal, trace);
    const result = await this.python.invoke(capability.id, args === undefined ? {} : args, {
      signal, invocationTrace: trace.spanId ? trace : undefined, env: { ...this.options.env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(trace) },
    });
    if (result.isError) throw new Error(`${result.details.error?.type ?? "PythonError"}: ${result.details.error?.message ?? "Capability failed"}`);
    return result.details.result;
  }

  private device(id: string) {
    return this.options.devices.catalog.controllers.find(item => id === `controller/${item.name}`);
  }

  async requiresControl(id: string, signal: AbortSignal, trace: EventTrace = {}) {
    const device = this.device(id);
    if (device) return device.requiresControl;
    await this.pythonCapability(id, signal, trace);
    // Python may compute, observe or compose effects; actual driver calls enforce control.
    return false;
  }

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
