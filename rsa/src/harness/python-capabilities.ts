import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { pythonExecutable, pythonEnvironment, pythonModulePaths } from "../../../shared/python.ts";
export { pythonModulePaths } from "../../../shared/python.ts";
import { childTrace, type EventTrace, type RecordEvent } from "./events.ts";

export interface PythonCapability {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
  recorded?: boolean;
}

export interface PythonDiagnostic {
  path: string;
  function?: string;
  line?: number;
  message: string;
}

export interface PythonDiscovery {
  capabilities: PythonCapability[];
  diagnostics: PythonDiagnostic[];
}

export interface PythonInvocationOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  trace?: EventTrace;
  /** The unified controller already owns a span for this invocation. */
  invocationTrace?: EventTrace;
}

export interface PythonInvocationDetails {
  capabilityId: string;
  origin: PythonCapability["origin"];
  codeSHA: string;
  result?: unknown;
  error?: { type: string; message: string; traceback?: string };
  exitCode: number;
  stderr: string;
}

/** Discover and execute workspace functions on demand. */
export class PythonCapabilities {
  readonly workspace: string;
  private catalog = new Map<string, PythonCapability>();

  constructor(workspace: string, readonly pythonPath = pythonExecutable(), private readonly record?: RecordEvent, private readonly diagnostics: "normal" | "full" = "normal") {
    this.workspace = resolve(workspace);
  }

  private emit(type: string, data: unknown, trace: EventTrace) {
    const continuous = trace.recordingPurpose === "continuous-perception" || trace.recordingPurpose === "continuous-action";
    if (!continuous || this.diagnostics === "full") this.record?.(type, data, trace,
      continuous ? { channel: "diagnostic" } : undefined);
  }

  async discover(signal?: AbortSignal, parent: EventTrace = {}): Promise<PythonDiscovery> {
    const trace = childTrace(parent), started = performance.now();
    this.emit("python_capabilities_start", {}, trace);
    try {
      const processResult = await this.run({ action: "discover", workspace: this.workspace }, { signal }, true);
      if (processResult.exitCode !== 0) throw new Error(`Python capability discovery failed: ${processResult.stdout || processResult.stderr}`);
      const result = JSON.parse(processResult.stdout) as PythonDiscovery;
      this.catalog = new Map(result.capabilities.map(capability => [capability.id, capability]));
      this.emit("python_capabilities", { ...result, outcome: "success", durationMs: performance.now() - started }, trace);
      return result;
    } catch (error) {
      this.emit("python_capabilities", { outcome: signal?.aborted ? "cancelled" : "error",
        durationMs: performance.now() - started, error: String(error) }, trace);
      throw error;
    }
  }

  async invoke(id: string, args: unknown, options: PythonInvocationOptions = {}) {
    const parent = options.trace ?? (options.env?.BASEWARE_TRACE ? JSON.parse(options.env.BASEWARE_TRACE) as EventTrace : {});
    const trace = options.invocationTrace ?? childTrace(parent), started = performance.now();
    const capability = this.catalog.get(id);
    const identity = { capabilityId: id, ...(capability ? { origin: capability.origin, codeSHA: capability.codeSHA } : {}) };
    this.emit("python_capability", { ...identity, arguments: args }, trace);
    try {
      options.signal?.throwIfAborted();
      if (!capability) throw new Error(`Unknown Python capability: ${id}; discover the workspace before invoking it`);
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Python capability arguments must be an object");
      const processResult = await this.run({ action: "invoke", workspace: this.workspace, capability, arguments: args }, {
        ...options, env: { ...options.env, BASEWARE_TRACE: JSON.stringify(trace) },
      });
      let reply: { ok: boolean; result?: unknown; error?: PythonInvocationDetails["error"] };
      try { reply = JSON.parse(processResult.stdout); }
      catch {
        reply = { ok: false, error: { type: "PythonProcessError", message: `Python exited ${processResult.exitCode} without a valid result` } };
      }
      const failed = !reply.ok || processResult.exitCode !== 0;
      const details: PythonInvocationDetails = { capabilityId: id, origin: capability.origin, codeSHA: capability.codeSHA,
        ...(failed ? { error: reply.error ?? { type: "PythonProcessError", message: `Python exited ${processResult.exitCode}` } } : { result: reply.result }),
        exitCode: processResult.exitCode, stderr: processResult.stderr };
      const result = details.result as { timeline?: unknown; media?: unknown[] } | undefined;
      this.emit("python_capability_result", { ...details,
        // Explicit recording owns the retained payload; invocation logs only reference it.
        ...(capability.recorded || result?.timeline || Array.isArray(result?.media) ? { result: result?.timeline
          ? { timeline: result.timeline } : { recorded: false } } : {}),
        outcome: failed ? "error" : "success", durationMs: performance.now() - started }, trace);
      return { content: [{ type: "text" as const, text: JSON.stringify(failed ? { error: details.error } : reply.result) }], details, isError: failed };
    } catch (error) {
      this.emit("python_capability_result", { ...identity, outcome: options.signal?.aborted ? "cancelled" : "error",
        durationMs: performance.now() - started,
        error: { type: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } }, trace);
      throw error;
    }
  }

  private run(request: unknown, options: PythonInvocationOptions, sourceOnly = false): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    options.signal?.throwIfAborted();
    const input = JSON.stringify(request);
    const env = pythonEnvironment({ ...options.env, RSA_WORKSPACE: this.workspace });
    // Static discovery must not import workspace modules that shadow the bridge
    // or its standard-library imports. Invocation retains the author's environment.
    if (sourceOnly) env.PYTHONPATH = pythonModulePaths().join(delimiter);
    for (const name of ["RSA_EPOCH", "RSA_TRACE"]) delete env[name];
    env.PYTHONDONTWRITEBYTECODE = "1";
    return new Promise((done, fail) => {
      const child = spawn(this.pythonPath, ["-B", "-m", "rsa_tools._bridge"], {
        cwd: sourceOnly ? pythonModulePaths()[0] : this.workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const cancel = () => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail(error); }
        }
      };
      const cleanup = () => options.signal?.removeEventListener("abort", cancel);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      // A process may terminate before consuming its input (e.g. invalid Python executable).
      child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error); });
      child.once("error", error => { cleanup(); fail(error); });
      child.once("close", code => {
        cleanup();
        if (options.signal?.aborted) fail(options.signal.reason ?? new DOMException("Python capability cancelled", "AbortError"));
        else done({ exitCode: code ?? 1, stdout, stderr });
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdin.end(input);
    });
  }
}
