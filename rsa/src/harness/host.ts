import { delimiter, resolve } from "node:path";
import { Runtime, type DeviceSession, type SharedBudget } from "./runtime.ts";
import { WorkspaceController } from "./controller.ts";
import { PerceptionRuntime } from "./perception.ts";
import { ActionRuntime } from "./action.ts";
import type { EventLog, RecordEvent } from "./events.ts";
import type { WorkspaceState } from "./workspace-state.ts";

/** The Host assembly used by daily play and evaluated agents. Transports remain owned by the caller. */
export async function createHostRuntime(options: {
  devices: DeviceSession; workspace: string; runDir: string; state: WorkspaceState;
  log: EventLog; record?: RecordEvent; rsaSocket: string; basewareSocket: string;
  seconds: number; model?: string; maxRequests: number; resume?: string; compactionThreshold?: number;
  action?: boolean; budget?: SharedBudget;
}) {
  const { devices, workspace, runDir, state, log, rsaSocket, basewareSocket } = options;
  const record = options.record ?? log.record;
  const runtime = new Runtime(devices, record, options.seconds, log.clock.id, log.diagnostics, options.budget);
  const binDir = resolve(import.meta.dir, "../../bin");
  const env = {
    RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket, RSA_WORKSPACE: workspace, RSA_RUN_ID: log.clock.id,
    RSA_LOG_DIAGNOSTICS: log.diagnostics, BASEWARE_TRACE: JSON.stringify({ recordingId: log.clock.id }),
    PATH: [binDir, resolve(import.meta.dir, "../../../baseware/bin"), process.env.PATH ?? ""].join(delimiter),
  };
  runtime.controller = new WorkspaceController({ workspace, devices, record, env });
  runtime.perception = new PerceptionRuntime({ workspace, runDir, env, record, registerMedia: log.registerMedia,
    diagnostics: log.diagnostics, clock: log.clock });
  if (options.action !== false) runtime.action = new ActionRuntime({ workspace, runDir, env, record, diagnostics: log.diagnostics,
    isAuto: epoch => runtime.status().mode === "auto" && runtime.status().epoch === epoch,
    setInputGeneration: (epoch, generation) => {
      if (!devices.setInputGeneration) throw new Error("Device session does not support input generations");
      return devices.setInputGeneration(epoch, generation);
    }, onCleanupError: error => { void runtime.stop(error.message); },
  });
  try {
    if (options.model) {
      const { createOmpAgent } = await import("./omp/session.ts");
      runtime.agent = await createOmpAgent({ runtime, workspace, runDir, state, log, binDir, rsaSocket, basewareSocket,
        model: options.model, maxRequests: options.maxRequests, resume: options.resume,
        compactionThreshold: options.compactionThreshold });
    }
    return runtime;
  } catch (error) { await runtime.close(); throw error; }
}
