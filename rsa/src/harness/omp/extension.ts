import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { ExtensionFactory, CustomTool, ReadToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import * as z from "@oh-my-pi/omptype/zod";
import type { Clock, Observation } from "@playness/baseware/contracts";
import type { Runtime } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import type { EventTrace, RecordEvent } from "../events.ts";
import { pythonModulePaths } from "../python-capabilities.ts";
import type { PerceptionRead } from "../perception.ts";

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
  runDir?: string;
  clock?: Clock;
  cycle(): Cycle;
  maxRequests: number;
  trace?(toolCallId?: string): EventTrace;
}) {
  const { runtime, workspace } = options;
  let requests = 0;
  let requestEpoch: string | undefined;
  const pendingTools = new Set<string>();
  let observed: PerceptionRead | undefined;
  let latestContext: { observations: string[]; executions: string[]; skills: Awaited<ReturnType<Workspace["snapshot"]>> };
  const trace = (toolCallId?: string): EventTrace => ({ epoch: options.cycle().epoch, ...options.trace?.(toolCallId), ...(toolCallId ? { toolCallId } : {}) });
  const observeParameters = z.object({});
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
    description: "Read the current workspace perception state. Implement perception.py and load it with rsa perception reload. Discover raw device capabilities through rsa controller.",
    parameters: observeParameters,
    async execute(id, params, _onUpdate, _ctx, signal) {
      const cycle = options.cycle();
      const read = await readPerception(signal ? AbortSignal.any([signal, cycle.signal]) : cycle.signal, trace(id));
      const content = await perceptionContent(read, trace(id));
      observed = read;
      return { content, details: read, isError: read.status.state === "error" };
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
      observed = undefined;
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

  async function readPerception(signal: AbortSignal, parent: EventTrace): Promise<PerceptionRead> {
    signal.throwIfAborted();
    if (runtime.perception) return runtime.perception.observe(signal, parent);
    const text = "Perception is not configured. Implement perception.py and run rsa perception reload.";
    return { status: { state: "unimplemented", generation: null }, error: text,
      result: { id: crypto.randomUUID(), status: "failed", exitCode: 1, stdout: text, stderr: text, observations: [],
        timing: { clock: "rsa", requestedAtMs: performance.now(), receivedAtMs: performance.now() } } };

  }

  async function perceptionContent(read: PerceptionRead, parent: EventTrace) {
    let images: Awaited<ReturnType<typeof media>> = [];
    try { images = await media(read.result?.observations ?? [], runtime.record, parent); }
    catch (error) {
      options.cycle().signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      read.status = { ...read.status, state: "error", error: message };
      read.error = message;
      read.snapshot = undefined;
      if (read.result) read.result = { ...read.result, observations: [], stdout: message, exitCode: 1, status: "failed" };
      runtime.record("perception_input_error", read, parent);
    }
    return [{ type: "text" as const, text: JSON.stringify(read) }, ...images];
  }

  async function captureContext(parent: EventTrace, origin: "prompt_start" | "tool_batch") {
    const cycle = options.cycle();
    cycle.signal.throwIfAborted();
    const consolidating = cycle.purpose === "consolidate";
    const reused = !consolidating && observed !== undefined;
    const perception = consolidating ? undefined : observed ?? await readPerception(cycle.signal, parent);
    // An explicit observe result already appears in the immutable tool history.
    const content = perception && !reused ? await perceptionContent(perception, parent) : [];
    const observations = perception?.result?.observations ?? [];
    const skills = await workspace.snapshot();
    cycle.signal.throwIfAborted();
    latestContext = { observations: observations.map(o => o.id),
      executions: perception?.result ? [perception.result.id] : [], skills };
    runtime.record("observation_context", { origin,
      observations: latestContext.observations, executions: latestContext.executions,
      purpose: cycle.purpose, perception: perception?.status, snapshot: perception?.snapshot,
      reusedObservations: reused || perception?.reused ? latestContext.observations : [],
      freshObservations: reused || perception?.reused ? [] : latestContext.observations,
      freshExecutions: reused ? [] : latestContext.executions,
      reusedExecutions: reused ? latestContext.executions : [],
      skillVersion: skills.version, memoryVersion: skills.memory.version }, parent);
    return [{ type: "text" as const, text: JSON.stringify({
      ...(consolidating ? { purpose: cycle.purpose } : {}),
      control: runtime.status(), observations, skills,
      perception: perception?.status, snapshot: perception?.snapshot,
    }) }, ...content];
  }

  const factory: ExtensionFactory = (pi) => {
    // OMP persists both the initial custom message and enriched tool results.
    // Keep history immutable between compactions so provider prefixes can be reused.
    pi.on("before_agent_start", async () => {
      observed = undefined;
      return { message: { customType: "rsa-observation", content: await captureContext({ epoch: options.cycle().epoch }, "prompt_start"), display: false } };
    });
    pi.on("assistant_message", () => {
      pendingTools.clear();
      observed = undefined;
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
