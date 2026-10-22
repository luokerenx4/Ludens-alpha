import { readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { ExtensionFactory, CustomTool, ReadToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";
import * as z from "@oh-my-pi/omptype/zod";
import type { Clock, Observation } from "@playness/baseware/contracts";
import type { Runtime } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import type { EventTrace, RecordEvent } from "../events.ts";
import { pythonModulePaths } from "../python-capabilities.ts";
import type { ObservationQuery, PerceptionRead } from "../perception.ts";

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
  const observeParameters = z.object({
    at: z.string().optional().describe("ISO timestamp: last record at or before this recordedAt; cannot combine with a range."),
    start: z.string().optional().describe("Inclusive ISO recordedAt range start."),
    end: z.string().optional().describe("Inclusive ISO recordedAt range end."),
    limit: z.number().int().min(1).max(64).optional().describe("Range page size; default 8."),
    after: z.number().int().min(0).optional().describe("Range cursor: records after this sequence; use nextAfter to continue."),
  });
  // Each RSA host owns one OMP session. Use OMP's existing extension environment
  // mechanism; native bash and its process manager own execution. Capture paths
  // once so repeated prompts do not keep prepending the same directories.
  const environment = {
    PATH: [options.binDir, resolve(import.meta.dir, "../../../../baseware/bin"), process.env.PATH ?? ""].join(delimiter),
    PYTHONPATH: [...pythonModulePaths(), ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter),
    RSA_SOCKET: options.rsaSocket ?? "",
    RSA_WORKSPACE: workspace.path, RSA_RUN_ID: runtime.status().runId,
    BASEWARE_SOCKET: options.basewareSocket, BASEWARE_EPOCH: "", BASEWARE_TRACE: "{}",
    RSA_EPOCH: "", RSA_TRACE: "",
  };
  const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));

  const observe: CustomTool<typeof observeParameters> = {
    name: "observe", label: "Observe", loadMode: "essential", approval: "read",
    description: "Read recorded workspace perception: latest by default, one past record with at, or a time range with start/end. Records carry timestamps and sampling intervals. Implement perception.py:Perception.sample and load it with rsa perception reload to start continuous recording. Discover raw device capabilities through rsa controller.",
    parameters: observeParameters,
    async execute(id, params, _onUpdate, _ctx, signal) {
      const cycle = options.cycle();
      const read = await readPerception(signal ? AbortSignal.any([signal, cycle.signal]) : cycle.signal, trace(id), params);
      const content = await perceptionContent(read, trace(id));
      observed = read;
      return { content, details: read, isError: read.result.exitCode !== 0 };
    },
  };

  async function readPerception(signal: AbortSignal, parent: EventTrace, query: ObservationQuery = {}): Promise<PerceptionRead> {
    signal.throwIfAborted();
    if (runtime.perception) return runtime.perception.observe(signal, parent, query);
    const text = "Perception is not configured. Implement perception.py and run rsa perception reload.";
    return { status: { state: "unimplemented", generation: null }, error: text,
      result: { id: crypto.randomUUID(), status: "failed", exitCode: 1, stdout: text, stderr: text, observations: [],
        timing: { clock: "rsa", requestedAtMs: performance.now(), receivedAtMs: performance.now() } } };

  }

  async function perceptionContent(read: PerceptionRead, parent: EventTrace) {
    let images: Awaited<ReturnType<typeof media>> = [];
    try {
      if (read.records && read.records.length > 1) {
        images = (await Promise.all(read.records.map(async record => [
          { type: "text" as const, text: `Observation #${record.snapshot.sequence} recordedAt=${record.snapshot.recordedAt}` },
          ...await media(record.observations, runtime.record, parent),
        ]))).flat();
      } else images = await media(read.result?.observations ?? [], runtime.record, parent);
    }
    catch (error) {
      options.cycle().signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      read.status = { ...read.status, state: "error", error: message };
      read.error = message;
      read.snapshot = undefined;
      read.records = [];
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
      query: perception?.query, records: perception?.records?.map(record => record.snapshot),
      reusedObservations: reused || perception?.reused ? latestContext.observations : [],
      freshObservations: reused || perception?.reused ? [] : latestContext.observations,
      freshExecutions: reused ? [] : latestContext.executions,
      reusedExecutions: reused ? latestContext.executions : [],
      skillVersion: skills.version, memoryVersion: skills.memory.version }, parent);
    return [{ type: "text" as const, text: JSON.stringify({
      ...(consolidating ? { purpose: cycle.purpose } : {}),
      control: runtime.status(), observations, skills,
      perception: perception?.status, snapshot: perception?.snapshot,
      query: perception?.query, records: perception?.records?.map(record => record.snapshot),
    }) }, ...content];
  }

  const factory: ExtensionFactory = (pi) => {
    // OMP persists both the initial custom message and enriched tool results.
    // Keep history immutable between compactions so provider prefixes can be reused.
    pi.on("before_agent_start", async () => {
      const cycle = options.cycle();
      cycle.signal.throwIfAborted();
      // Existing processes retain their startup epoch. Only future shells get
      // this lease; child processes never inherit a later takeover implicitly.
      Object.assign(process.env, environment, {
        BASEWARE_EPOCH: cycle.epoch, BASEWARE_TRACE: JSON.stringify({ epoch: cycle.epoch }),
      });
      refreshShellConfigCache();
      observed = undefined;
      return { message: { customType: "rsa-observation", content: await captureContext({ epoch: options.cycle().epoch }, "prompt_start"), display: false } };
    });
    pi.on("session_shutdown", () => {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      refreshShellConfigCache();
    });
    pi.on("assistant_message", () => {
      pendingTools.clear();
      observed = undefined;
    });
    pi.on("tool_result", async (event) => {
      if (event.toolName === "bash") observed = undefined;
      if (event.toolName === "read") {
        // OMP resolves selectors such as SKILL.md:19-22. Use its result metadata
        // instead of treating the selector as part of a filesystem path.
        const details = (event as ReadToolResultEvent).details;
        const source = details?.meta?.source;
        const resolvedPath = details?.resolvedPath ?? (source?.type === "path" ? source.value : undefined);
        const path = resolvedPath && source?.type !== "url" && !resolvedPath.includes("://") ? resolve(workspace.path, resolvedPath) : undefined;
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
  return { factory, tools: [observe], context: () => ({ observations: latestContext?.observations, executions: latestContext?.executions,
    skillVersion: latestContext?.skills.version, memoryVersion: latestContext?.skills.memory.version }) };
}
