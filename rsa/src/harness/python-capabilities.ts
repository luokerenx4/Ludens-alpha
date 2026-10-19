import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventTrace, RecordEvent } from "./events.ts";

export interface PythonCapability {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  origin: { path: string; function: string; line: number };
  codeSHA: string;
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

/** Add these paths to PYTHONPATH for workspace shell scripts using either SDK. */
export function pythonModulePaths(): string[] {
  return [fileURLToPath(new URL("../../python", import.meta.url)),
    fileURLToPath(new URL("../../../baseware/python", import.meta.url))];
}

const bridge = fileURLToPath(new URL("../../python/rsa_tools/_bridge.py", import.meta.url));

/** A refreshed tool catalog, not a daemon or file watcher. */
export class PythonCapabilities {
  readonly workspace: string;
  private catalog = new Map<string, PythonCapability>();

  constructor(workspace: string, readonly pythonPath = process.env.RSA_PYTHON ?? "python3", private readonly record?: RecordEvent) {
    this.workspace = resolve(workspace);
  }

  async discover(signal?: AbortSignal): Promise<PythonDiscovery> {
    const processResult = await this.run({ action: "discover", workspace: this.workspace }, { signal });
    if (processResult.exitCode !== 0) throw new Error(`Python capability discovery failed: ${processResult.stdout || processResult.stderr}`);
    const result = JSON.parse(processResult.stdout) as PythonDiscovery;
    this.catalog = new Map(result.capabilities.map(capability => [capability.id, capability]));
    this.record?.("python_capabilities", result);
    return result;
  }

  async invoke(id: string, args: unknown, options: PythonInvocationOptions = {}) {
    options.signal?.throwIfAborted();
    const capability = this.catalog.get(id);
    if (!capability) throw new Error(`Unknown Python capability: ${id}; discover the workspace before invoking it`);
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Python capability arguments must be an object");
    this.record?.("python_capability", { capabilityId: id, origin: capability.origin, codeSHA: capability.codeSHA, arguments: args }, options.trace);
    const processResult = await this.run({ action: "invoke", workspace: this.workspace, capability, arguments: args }, options);
    let reply: { ok: boolean; result?: unknown; error?: PythonInvocationDetails["error"] };
    try { reply = JSON.parse(processResult.stdout); }
    catch {
      reply = { ok: false, error: { type: "PythonProcessError", message: `Python exited ${processResult.exitCode} without a valid result` } };
    }
    const failed = !reply.ok || processResult.exitCode !== 0;
    const details: PythonInvocationDetails = { capabilityId: id, origin: capability.origin, codeSHA: capability.codeSHA,
      ...(failed ? { error: reply.error ?? { type: "PythonProcessError", message: `Python exited ${processResult.exitCode}` } } : { result: reply.result }),
      exitCode: processResult.exitCode, stderr: processResult.stderr };
    this.record?.("python_capability_result", details, options.trace);
    return { content: [{ type: "text" as const, text: JSON.stringify(failed ? { error: details.error } : reply.result) }], details, isError: failed };
  }

  private run(request: unknown, options: PythonInvocationOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    options.signal?.throwIfAborted();
    const input = JSON.stringify(request);
    const env = { ...process.env, ...options.env };
    env.PYTHONPATH = [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
    env.PYTHONDONTWRITEBYTECODE = "1";
    return new Promise((done, fail) => {
      const child = spawn(this.pythonPath, ["-B", bridge], { cwd: this.workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
