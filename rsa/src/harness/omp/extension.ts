import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { ExtensionFactory, CustomTool, ReadToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import * as z from "@oh-my-pi/omptype/zod";
import type { Clock, Observation, ControllerRequest, ExecutionResult } from "@playness/baseware/contracts";
import type { Runtime } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import type { EventTrace, RecordEvent } from "../events.ts";
import { pythonModulePaths } from "../python-capabilities.ts";
import { runObserveHook } from "../observe-hook.ts";

export async function media(observations: Observation[], record?: RecordEvent, trace?: EventTrace) {
  return Promise.all(observations.map(async (observation) => {
    if (observation.mediaType.startsWith("text/") || observation.mediaType === "application/json") {
      return { type: "text" as const, text: await readFile(observation.path, "utf8") };
    }
    if (!observation.mediaType.startsWith("image/")) throw new Error(`Unsupported model media: ${observation.mediaType}`);
    // Use OMP's normal image path once, before persistence. Re-encoding history
    // during each request would waste work and risk changing cache prefixes.
    const started = performance.now();
    const bytes = await readFile(observation.path);
    const image = await resizeImage({ bytes, mimeType: observation.mediaType });
    record?.("observation_media", { observationId: observation.id, durationMs: performance.now() - started,
      sourceBytes: bytes.byteLength, modelBytes: Buffer.byteLength(image.data, "base64"),
      mimeType: image.mimeType, width: image.width, height: image.height, decodeFailed: image.decodeFailed,
    }, trace);
    return { type: "image" as const, data: image.data, mimeType: image.mimeType };
  }));
}

export interface Cycle { epoch: string; signal: AbortSignal; purpose?: "consolidate" }

export function createRsaExtension(options: {
  runtime: Runtime;
  workspace: Workspace;
  basewareSocket: string;
  rsaSocket?: string;
  binDir: string;
  autoObserve: ControllerRequest[];
  runDir?: string;
  clock?: Clock;
  cycle(): Cycle;
  maxRequests: number;
  trace?(toolCallId?: string): EventTrace;
}) {
  const { runtime, workspace } = options;
  const hookClock = options.clock ?? { id: crypto.randomUUID(), now: () => performance.now() };
  let requests = 0;
  let requestEpoch: string | undefined;
  const pendingTools = new Set<string>();
  const observed = new Map<string, ExecutionResult>();
  let latestContext: { observations: string[]; executions: string[]; skills: Awaited<ReturnType<Workspace["snapshot"]>> };
  const trace = (toolCallId?: string): EventTrace => ({ epoch: options.cycle().epoch, ...options.trace?.(toolCallId), ...(toolCallId ? { toolCallId } : {}) });
  const observeParameters = z.object({
    controllerId: z.string().describe("Controller ID without the controller/ prefix used in the catalog."),
    argv: z.array(z.string()),
  });
  const execParameters = z.object({ command: z.string() });

  const commandEnvironment = (cycle: Cycle, parent: EventTrace): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [options.binDir, resolve(import.meta.dir, "../../../../baseware/bin"), process.env.PATH ?? ""].join(delimiter),
      PYTHONPATH: [...pythonModulePaths(), ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter),
      RSA_SOCKET: options.rsaSocket,
      RSA_WORKSPACE: workspace.path, RSA_RUN_ID: runtime.status().runId,
      BASEWARE_SOCKET: options.basewareSocket, BASEWARE_EPOCH: cycle.epoch, BASEWARE_TRACE: JSON.stringify(parent),
    };
    // A launching shell may still carry an obsolete RSA control context.
    for (const name of ["RSA_EPOCH", "RSA_TRACE"]) delete env[name];
    return env;
  };

  const observe: CustomTool<typeof observeParameters> = {
    name: "observe", label: "Observe", loadMode: "essential", approval: "read",
    description: "Call an injected read-only controller for additional information or media when the loop's observation is insufficient. Use rsa controller list and rsa controller <id> --help to discover controller arguments.",
    parameters: observeParameters,
    async execute(id, params, _onUpdate, _ctx, signal) {
      const cycle = options.cycle();
      const result = await runtime.observe(params, signal ? AbortSignal.any([signal, cycle.signal]) : cycle.signal, trace(id), "explicit");
      const content = await media(result.observations ?? [], runtime.record, trace(id));
      observed.set(params.controllerId, result);
      return { content: [{ type: "text", text: JSON.stringify(result) }, ...content], details: result };
    },
  };

  const exec: CustomTool<typeof execParameters> = {
    name: "exec", label: "Shell", loadMode: "essential", approval: "exec",
    description: "Run a foreground shell command in the workspace. Use rsa controller to discover and invoke capabilities; the Python API and current control epoch are supplied.",
    parameters: execParameters,
    async execute(id, params, _onUpdate, _ctx, signal) {
      const cycle = options.cycle();
      const combined = signal ? AbortSignal.any([signal, cycle.signal]) : cycle.signal;
      combined.throwIfAborted();
      // A shell command may change the environment; earlier observations no
      // longer describe the end of this batch, even if that command fails.
      observed.clear();
      const skills = await workspace.snapshot();
      combined.throwIfAborted();
      const parent = trace(id);
      runtime.record("exec", { command: params.command, epoch: cycle.epoch, skillVersion: skills.version, memoryVersion: skills.memory.version }, parent);
      const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn("/bin/sh", ["-c", params.command], {
          cwd: workspace.path, detached: true,
          env: commandEnvironment(cycle, parent),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        const cancel = () => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail(error); }
          }
        };
        combined.addEventListener("abort", cancel, { once: true });
        child.once("error", fail);
        child.once("close", (code) => { combined.removeEventListener("abort", cancel); done({ exitCode: code ?? 130, stdout, stderr }); });
      });
      runtime.record("exec_result", result, parent);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.exitCode !== 0 };
    },
  };

  async function captureContext(parent: EventTrace, origin: "prompt_start" | "tool_batch") {
    const cycle = options.cycle();
    cycle.signal.throwIfAborted();
    try {
      const consolidating = cycle.purpose === "consolidate";
      // A workspace hook owns automatic collection; explicit observe remains independent.
      let hook = consolidating ? undefined : await runObserveHook({
        workspace: workspace.path, runDir: options.runDir ?? join(workspace.versions, "observer-run"),
        env: commandEnvironment(cycle, parent), signal: cycle.signal, trace: parent,
        clock: hookClock, record: runtime.record,
      });
      let hookContent: Awaited<ReturnType<typeof media>> | undefined;
      if (hook?.result) {
        try { hookContent = await media(hook.result.observations ?? [], runtime.record, parent); }
        catch (error) {
          cycle.signal.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          runtime.record("observe_hook_error", { hook: hook.hook, phase: "media", error: message }, parent);
          hook = { ...hook, result: undefined, error: message };
        }
      }
      const fresh = hook?.result ? [{ controllerId: hook.hook!.id, result: hook.result }]
        : consolidating ? [] : await Promise.all(options.autoObserve.filter(request => !observed.has(request.controllerId))
        .map(async request => ({ controllerId: request.controllerId, result: await runtime.observe(request, cycle.signal, parent, origin) })));
      const reused = consolidating || hook?.result ? [] : options.autoObserve.flatMap(request => {
        const result = observed.get(request.controllerId);
        return result ? [{ controllerId: request.controllerId, result }] : [];
      });
      const samples = [...reused, ...fresh];
      const observations = samples.flatMap(({ result }) => result.observations ?? []);
      const skills = await workspace.snapshot();
      // Explicit observe results already contain their text and media in history.
      const content = hookContent ?? await media(fresh.flatMap(({ result }) => result.observations ?? []), runtime.record, parent);
      const controllerOutputs = fresh.filter(({ result }) => result.stdout || result.stderr).map(({ controllerId, result }) => ({
        controllerId, executionId: result.id, stdout: result.stdout, stderr: result.stderr,
      }));
      cycle.signal.throwIfAborted();
      latestContext = { observations: observations.map((o) => o.id), executions: samples.map(({ result }) => result.id), skills };
      runtime.record("observation_context", { origin, observations: latestContext.observations,
        executions: latestContext.executions, purpose: cycle.purpose,
        hook: hook?.hook, hookError: hook?.error,
        freshObservations: fresh.flatMap(({ result }) => result.observations?.map(o => o.id) ?? []),
        reusedObservations: reused.flatMap(({ result }) => result.observations?.map(o => o.id) ?? []),
        freshExecutions: fresh.map(({ result }) => result.id), reusedExecutions: reused.map(({ result }) => result.id),
        skillVersion: skills.version, memoryVersion: skills.memory.version }, parent);
      return [{ type: "text" as const, text: JSON.stringify({
        ...(consolidating ? { purpose: cycle.purpose } : {}),
        control: runtime.status(), observations, skills,
        ...(controllerOutputs.length ? { controllerOutputs } : {}),
        ...(hook?.hook ? { observeHook: hook.hook } : {}),
        ...(hook?.error ? { observeHookError: hook.error } : {}),
        ...(hook?.diagnostics.length ? { capabilityDiagnostics: hook.diagnostics } : {}),
      }) }, ...content];
    } catch (error) { await runtime.stop(`observation failed: ${error}`); throw error; }
  }

  const factory: ExtensionFactory = (pi) => {
    // OMP persists both the initial custom message and enriched tool results.
    // Keep history immutable between compactions so provider prefixes can be reused.
    pi.on("before_agent_start", async () => {
      observed.clear();
      return { message: { customType: "rsa-observation", content: await captureContext({ epoch: options.cycle().epoch }, "prompt_start"), display: false } };
    });
    pi.on("assistant_message", () => {
      pendingTools.clear();
      observed.clear();
    });
    pi.on("tool_result", async (event) => {
      if (event.toolName === "read") {
        // OMP resolves selectors such as SKILL.md:19-22. Use its result metadata
        // instead of treating the selector as part of a filesystem path.
        const details = (event as ReadToolResultEvent).details;
        const source = details?.meta?.source;
        const resolvedPath = details?.resolvedPath ?? (source?.type === "path" ? source.value : undefined);
        const path = resolvedPath ? resolve(workspace.path, resolvedPath) : undefined;
        const file = path ? Bun.file(path) : undefined;
        const hash = !event.isError && file && await file.exists()
          ? new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex") : undefined;
        runtime.record("read", { requestedPath: event.input.path, path, hash, isError: event.isError }, trace(event.toolCallId));
      }
      pendingTools.delete(event.toolCallId);
      if (pendingTools.size) return;
      if (options.cycle().signal.aborted) return;
      // tool_result is awaited before persistence and the next model request;
      // turn_end is only a notification. Attach one observation per tool batch.
      return { content: [...event.content, ...await captureContext(trace(event.toolCallId), "tool_batch")] };
    });
    pi.on("context", async () => {
      const cycle = options.cycle();
      cycle.signal.throwIfAborted();
      // A new takeover gets a fresh budget without replacing the OMP session.
      if (requestEpoch !== cycle.epoch) {
        requestEpoch = cycle.epoch;
        requests = 0;
      }
      if (requests >= options.maxRequests) {
        await runtime.stop("model request budget");
        cycle.signal.throwIfAborted();
      }
      runtime.record("context", { request: ++requests, purpose: cycle.purpose, ...latestContext,
        memoryVersion: latestContext?.skills.memory.version }, { epoch: cycle.epoch });
    });
    pi.on("tool_call", async (event) => {
      if (options.cycle().signal.aborted) return { block: true, reason: "Human reclaimed control" };
      // OMP prepares all validated calls before dispatching the batch. Invalid
      // calls never execute or emit tool_result, so do not count them here.
      pendingTools.add(event.toolCallId);
    });
  };
  return { factory, tools: [observe, exec], context: () => ({ observations: latestContext?.observations, executions: latestContext?.executions,
    skillVersion: latestContext?.skills.version, memoryVersion: latestContext?.skills.memory.version }) };
}
