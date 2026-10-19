import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Clock, ExecutionResult, Observation } from "@playness/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent } from "./events.ts";
import { PythonCapabilities, type PythonCapability, type PythonDiagnostic } from "./python-capabilities.ts";

export interface ObserveHookIdentity { id: string; codeSHA: string; path: string }
export interface ObserveHookResult {
  hook?: ObserveHookIdentity;
  result?: ExecutionResult;
  error?: string;
  diagnostics: PythonDiagnostic[];
}

/** A workspace function owns collection and processing; the host only archives its result. */
export async function runObserveHook(options: {
  workspace: string; runDir: string; env: NodeJS.ProcessEnv;
  clock: Clock; signal: AbortSignal; trace: EventTrace; record: RecordEvent;
}): Promise<ObserveHookResult> {
  const { signal, clock, record } = options;
  const trace = childTrace(options.trace);
  const python = new PythonCapabilities(options.workspace, options.env.RSA_PYTHON, record);
  let hook: ObserveHookIdentity | undefined;
  let diagnostics: PythonDiagnostic[] = [];
  let started: number | undefined;
  try {
    const discovered = await python.discover(signal, trace);
    diagnostics = discovered.diagnostics;
    const hooks = discovered.capabilities.filter(capability => capability.hook === "observe");
    const invalid = diagnostics.filter(diagnostic => diagnostic.hook !== undefined);
    if (invalid.length) throw new Error(invalid.map(item => `${item.path}: ${item.message}`).join("\n"));
    if (hooks.length > 1) throw new Error(`Expected one observe hook; found ${hooks.map(item => item.origin.path + ":" + item.origin.function).join(", ")}`);
    const capability = hooks[0];
    if (!capability) return { diagnostics };
    hook = identity(capability);
    started = clock.now();
    record("observe_hook_start", { hook }, trace);
    const source = await readFile(resolve(options.workspace, capability.origin.path));
    if (createHash("sha256").update(source).digest("hex") !== capability.codeSHA) throw new Error("Observe hook changed during discovery; retry on the next observation");
    const sourceDir = join(options.runDir, "observer-sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, `${capability.codeSHA}.py`), source);
    const invoked = await python.invoke(capability.id, {}, { signal, env: options.env, invocationTrace: trace });
    if (invoked.isError) throw new Error(`${invoked.details.error?.type}: ${invoked.details.error?.message}`);
    const value = invoked.details.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Observe hook must return {text?: string, media?: [{path, mediaType}]}");
    const { text = "", media = [] } = value as { text?: unknown; media?: unknown };
    if (typeof text !== "string" || !Array.isArray(media)) throw new Error("Observe hook text must be a string and media must be an array");
    const directory = join(options.runDir, "observations");
    await mkdir(directory, { recursive: true });
    const observations: Observation[] = [];
    for (const item of media) {
      if (!item || typeof item !== "object" || typeof item.path !== "string" || typeof item.mediaType !== "string") {
        throw new Error("Observe hook media entries need path and mediaType strings");
      }
      const id = crypto.randomUUID();
      const path = join(directory, `${id}-${basename(item.path)}`);
      // Archive bytes before the next invocation can overwrite the workspace's output file.
      await writeFile(path, await readFile(resolve(options.workspace, item.path)), { flag: "wx" });
      observations.push({ id, controllerId: hook.id, mediaType: item.mediaType, path,
        timing: { clock: clock.id, requestedAtMs: started, receivedAtMs: clock.now() } });
    }
    signal.throwIfAborted();
    const result: ExecutionResult = { id: crypto.randomUUID(), status: "completed", exitCode: 0,
      stdout: text, stderr: "", observations,
      timing: { clock: clock.id, requestedAtMs: started, receivedAtMs: clock.now() } };
    record("observe_hook_end", { hook, outcome: "success", result, durationMs: clock.now() - started }, trace);
    return { hook, result, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(started === undefined ? "observe_hook_error" : "observe_hook_end", {
      hook, outcome: signal.aborted ? "cancelled" : "error", error: message,
      ...(started === undefined ? {} : { durationMs: clock.now() - started }),
    }, trace);
    if (signal.aborted) throw error;
    return { hook, error: message, diagnostics };
  }
}

function identity(capability: PythonCapability): ObserveHookIdentity {
  return { id: `python/${capability.origin.path}:${capability.origin.function}`,
    codeSHA: capability.codeSHA, path: capability.origin.path };
}
