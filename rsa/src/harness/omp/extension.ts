import { realpath, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { ExtensionFactory, CustomTool, ReadToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";
import * as z from "@oh-my-pi/omptype/zod";
import type { Clock, Observation } from "@playness/baseware/contracts";
import type { Runtime } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import type { EventTrace, RecordEvent } from "../events.ts";
import { pythonEnvironment } from "../../../../shared/python.ts";
import { observationBytes, observationMetadata, perceptionMetadata, type DeriveMedia, type TimelineMedia, type ObservationQuery, type PerceptionRead } from "../perception.ts";

export async function media(observations: Observation[], record?: RecordEvent, trace?: EventTrace, derive?: DeriveMedia) {
  return Promise.all(observations.map(async (observation) => {
    if (observation.mediaType.startsWith("text/") || observation.mediaType === "application/json") {
      return { type: "text" as const, text: (await observationBytes(observation)).toString("utf8") };
    }
    if (!observation.mediaType.startsWith("image/")) throw new Error(`Unsupported model media: ${observation.mediaType}`);
    // Use OMP's normal image path once, before persistence. Re-encoding history
    // during each request would waste work and risk changing cache prefixes.
    const started = performance.now();
    const bytes = await observationBytes(observation);
    const image = await resizeImage({ bytes, mimeType: observation.mediaType });
    const encodingMs = performance.now() - started;
    const archiveStarted = performance.now();
    let modelMedia: TimelineMedia | undefined, archiveError: string | undefined;
    const source = observation.timeline;
    if (derive && source?.recordId && source.sequence !== undefined) {
      try {
        modelMedia = await derive({ source: { asset: source.asset, recordId: source.recordId, sequence: source.sequence },
          data: image.data, mediaType: image.mimeType, transform: "omp.resizeImage" });
      } catch (error) {
        // Logging must not replace a valid model input with a failed capture.
        // An expired window remains unavailable, never copied into another store.
        archiveError = String(error);
      }
    }
    record?.("observation_media", { observationId: observation.id, durationMs: encodingMs,
      sourceBytes: bytes.byteLength, modelBytes: Buffer.byteLength(image.data, "base64"),
      mimeType: image.mimeType, width: image.width, height: image.height, decodeFailed: image.decodeFailed,
      modelMedia, archiveError, archiveMs: performance.now() - archiveStarted,
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
  let toolImages: Observation[] = [];
  const deliveredBackground = new Set<string>();
  let latestContext: { observations: string[]; executions: string[]; skills: Awaited<ReturnType<Workspace["snapshot"]>> };
  const trace = (toolCallId?: string): EventTrace => ({ epoch: options.cycle().epoch, ...options.trace?.(toolCallId), ...(toolCallId ? { toolCallId } : {}) });
  const observeParameters = z.object({
    capability: z.string().nullable().optional().describe("Perception capability ID, or '*' for all. Default: Perception.sample."),
    id: z.string().nullable().optional().describe("Read one workspace timeline record by ID."),
    at: z.string().nullable().optional().describe("ISO timestamp: last record at or before recordedAt. Omit or null when using a range."),
    start: z.string().nullable().optional().describe("Inclusive ISO recordedAt range start. Omit or null when unused."),
    end: z.string().nullable().optional().describe("Inclusive ISO recordedAt range end. Omit or null when unused."),
    limit: z.number().int().min(1).max(64).nullable().optional().describe("Range page size; omit or null for default 8."),
    after: z.number().int().min(0).nullable().optional().describe("Range cursor from nextAfter; 0 starts history. Omit or null when unused."),
  });
  // Each RSA host owns one OMP session. Use OMP's existing extension environment
  // mechanism; native bash and its process manager own execution. Capture paths
  // once so repeated prompts do not keep prepending the same directories.
  const python = pythonEnvironment();
  const environment = {
    RSA_PYTHON: python.RSA_PYTHON,
    PATH: [options.binDir, resolve(import.meta.dir, "../../../../baseware/bin"), python.PATH ?? ""].join(delimiter),
    PYTHONPATH: python.PYTHONPATH,
    RSA_SOCKET: options.rsaSocket ?? "",
    RSA_WORKSPACE: workspace.path, RSA_RUN_ID: runtime.status().runId,
    RSA_ARTIFACT_ROOT: process.env.RSA_ARTIFACT_ROOT ?? resolve(import.meta.dir, "../../../../../artifacts/rsa"),
    BASEWARE_SOCKET: options.basewareSocket, BASEWARE_EPOCH: "", BASEWARE_TRACE: "{}",
    RSA_EPOCH: "", RSA_TRACE: "",
  };
  const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));

  const observe: CustomTool<typeof observeParameters> = {
    name: "observe", label: "Observe", loadMode: "essential", approval: "read",
    description: "Read the workspace timeline: latest main perception by default, a record by id, at a timestamp, or a start/end range. Select another perception capability when needed. Mark Perception.sample with @perception and @record, then rsa perception reload. Discover devices through rsa controller.",
    parameters: observeParameters,
    async execute(id, params, _onUpdate, _ctx, signal) {
      const cycle = options.cycle();
      const read = await readPerception(signal ? AbortSignal.any([signal, cycle.signal]) : cycle.signal, trace(id), params);
      const content = await perceptionContent(read, trace(id));
      observed = read;
      toolImages.push(...(read.result.observations ?? []));
      return { content, details: perceptionMetadata(read, true), isError: read.result.exitCode !== 0 };
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
    const derive: DeriveMedia | undefined = runtime.perception
      ? input => runtime.perception!.deriveMedia(input, options.cycle().signal) : undefined;
    try {
      if (read.records?.length) {
        images = (await Promise.all(read.records.map(async record => [
          { type: "text" as const, text: `Recorded observation #${record.snapshot.sequence} recordedAt=${record.snapshot.recordedAt}` },
          ...await media(record.observations, runtime.record, parent, derive),
        ]))).flat();
      } else images = await media(read.result?.observations ?? [], runtime.record, parent, derive);
    }
    catch (error) {
      options.cycle().signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      read.status = { ...read.status, state: "error", error: message };
      read.error = message;
      read.snapshot = undefined;
      read.records = [];
      if (read.result) read.result = { ...read.result, observations: [], stdout: message, exitCode: 1, status: "failed" };
      runtime.record("perception_input_error", perceptionMetadata(read), parent);
    }
    return [{ type: "text" as const, text: JSON.stringify(perceptionMetadata(read, true)) }, ...images];
  }

  // Native tool images remain in OMP's own history. Delivery metadata is not
  // permission to create another permanent media archive.
  async function recordToolImages(images: ImageContent[], parent: EventTrace, source: string, content: unknown[] = []) {
    const observations: Observation[] = [];
    // rsa observe --images prints an explicit record marker for each terminal
    // image. Pair that marker with the registered byte hash, never a nearest frame.
    const markers = content.flatMap(part => {
      const value = part as { type?: string; text?: string };
      return value.type === "text" && typeof value.text === "string"
        ? [...value.text.matchAll(/Image \d+: ([a-zA-Z0-9-]+) \| observation #/g)].map(match => match[1]) : [];
    });
    for (const [index, image] of images.entries()) {
      const bytes = Buffer.from(image.data, "base64");
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const delivered = runtime.perception?.deliveredMediaReference(hash, markers[index]);
      // Exact byte identity can reuse an existing recorded asset. This does
      // not infer its capture time or which of several records produced it.
      const root = join(workspace.path, ".rsa", "timeline");
      const asset = `objects/${hash}.bin`, path = join(root, asset);
      const retained = await Promise.all([realpath(root), realpath(path), stat(path)])
        .then(([canonicalRoot, canonicalPath, file]) => canonicalPath === join(canonicalRoot, asset)
          && file.isFile() && file.size === bytes.length).catch(() => false);
      const now = options.clock?.now() ?? performance.now();
      const observation: Observation = { id: crypto.randomUUID(), controllerId: source, mediaType: image.mimeType,
        ...(delivered ? { timeline: { asset: delivered.asset, recordId: delivered.recordId, sequence: delivered.sequence,
          ...(delivered.video ? { video: delivered.video } : {}) } } : retained ? { path, timeline: { asset } } : {}),
        timing: { clock: options.clock?.id ?? runtime.status().runId, requestedAtMs: now, receivedAtMs: now } };
      runtime.record("observation", { ...observation, origin: "tool_result", sha256: hash, recorded: !!delivered || retained }, parent);
      runtime.record("observation_media", { observationId: observation.id, modelBytes: bytes.length, mimeType: image.mimeType,
        ...(delivered ? { modelMedia: delivered } : {}) }, parent);
      observations.push(observation);
    }
    return observations;
  }

  async function captureContext(parent: EventTrace, origin: "prompt_start" | "tool_batch") {
    const cycle = options.cycle();
    cycle.signal.throwIfAborted();
    const consolidating = cycle.purpose === "consolidate";
    const reused = !consolidating && observed !== undefined;
    const perception = consolidating ? undefined : observed ?? (toolImages.length ? undefined : await readPerception(cycle.signal, parent));
    // An explicit observe result already appears in the immutable tool history.
    const content = perception && !reused ? await perceptionContent(perception, parent) : [];
    const observations = [...new Map([...(perception?.result?.observations ?? []), ...toolImages].map(o => [o.id, o])).values()];
    const reusedIds = new Set(reused || perception?.reused ? perception?.result?.observations?.map(o => o.id) : []);
    const skills = await workspace.snapshot();
    cycle.signal.throwIfAborted();
    latestContext = { observations: observations.map(o => o.id),
      executions: perception?.result ? [perception.result.id] : [], skills };
    runtime.record("observation_context", { origin,
      observations: latestContext.observations, executions: latestContext.executions,
      purpose: cycle.purpose, perception: perception?.status, snapshot: perception?.snapshot,
      query: perception?.query, records: perception?.records?.map(record => record.snapshot),
      reusedObservations: latestContext.observations.filter(id => reusedIds.has(id)),
      freshObservations: latestContext.observations.filter(id => !reusedIds.has(id)),
      freshExecutions: reused ? [] : latestContext.executions,
      reusedExecutions: reused ? latestContext.executions : [],
      skillVersion: skills.version, memoryVersion: skills.memory.version }, parent);
    return [{ type: "text" as const, text: JSON.stringify({
      ...(consolidating ? { purpose: cycle.purpose } : {}),
      control: runtime.status(), observations: observations.map(observationMetadata), skills,
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
      toolImages = [];
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
      toolImages = [];
    });
    pi.on("tool_result", async (event) => {
      if (event.toolName === "bash") observed = undefined;
      if (event.toolName !== "observe") {
        const images = event.content.filter((part): part is ImageContent => part.type === "image");
        toolImages.push(...await recordToolImages(images, trace(event.toolCallId), event.toolName, event.content));
      }
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
      return { content: [...event.content, ...await captureContext(trace(event.toolCallId), "tool_batch")], isError: event.isError };
    });
    pi.on("context", async (event) => {
      const cycle = options.cycle();
      cycle.signal.throwIfAborted();
      // OMP delivers async images as custom messages, outside tool_result.
      // Inspect only the new tail, not old images carried across compactions.
      const tail = (event.messages ?? []).slice((event.messages ?? []).findLastIndex(message => message.role === "assistant") + 1);
      for (const message of tail) {
        if (message.role !== "custom" || message.customType !== ASYNC_RESULT_MESSAGE_TYPE || !Array.isArray(message.content)) continue;
        const key = JSON.stringify([message.timestamp, message.details]);
        if (deliveredBackground.has(key)) continue;
        deliveredBackground.add(key);
        const images = message.content.filter((part): part is ImageContent => part.type === "image");
        const inputs = await recordToolImages(images, { epoch: cycle.epoch }, "background_result", message.content);
        if (!inputs.length) continue;
        latestContext = { ...latestContext, observations: [...latestContext.observations, ...inputs.map(o => o.id)] };
        runtime.record("observation_context", { origin: "background_result", observations: latestContext.observations,
          executions: latestContext.executions, freshObservations: inputs.map(o => o.id) }, { epoch: cycle.epoch });
      }
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
