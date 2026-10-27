import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import type { Clock, ExecutionResult, Observation } from "@playness/baseware/contracts";
import { childTrace, type EventTrace, type RecordEvent, type RegisterMedia, type DiagnosticsMode, type EventMetadata } from "./events.ts";
import { pythonModulePaths } from "./python-capabilities.ts";
import { pythonExecutable } from "../../../shared/python.ts";
import { PythonWorker, type WorkerReply } from "./python-worker.ts";
import type { VideoFrameReference } from "../../../shared/timeline-types.ts";

export interface PerceptionStatus {
  state: "unimplemented" | "loading" | "ready" | "stopped" | "error";
  generation: string | null;
  pid?: number;
  codeSHA?: string;
  error?: string;
  sampleHz?: number;
  history?: { persistent: boolean; hotSeconds: number; segmentSeconds: number; hotBytes: number; segmentBytes: number };
}
export interface PerceptionSnapshot {
  id: string;
  sequence: number;
  generation: string | null;
  capability?: string;
  identity?: TimelineAppend["identity"];
  trace?: EventTrace;
  runId?: string | null;
  timeline?: { recordId: string; sequence: number };
  recordedAt: string;
  sampling: { clock: string; startedAtMs: number; finishedAtMs: number };
  sampledAt?: string;
  sources?: unknown[];
}
export interface ObservationQuery {
  at?: string | null; start?: string | null; end?: string | null;
  limit?: number | null; after?: number | null;
  capability?: string | null; id?: string | null;
}
export interface PerceptionRecord {
  snapshot: PerceptionSnapshot; text: string; observations: Observation[];
  data?: unknown; space?: unknown;
}
export interface TimelineAppend {
  sample: unknown; identity: { id: string; codeSHA?: string; origin?: unknown };
  sampling: { clock: string; startedAtMs: number; finishedAtMs: number };
  generation?: string | null; runId?: string; trace?: EventTrace;
}
export interface TimelineDerive {
  source: { asset: string; recordId: string; sequence: number };
  data: string; mediaType: string; transform: string;
}
export interface TimelineMedia {
  sha256: string; asset: string; mediaType: string; bytes: number;
  recordId: string; sequence: number; sourceAsset: string; transform: string;
  video?: VideoFrameReference;
  approximate?: boolean;
}
export type DeriveMedia = (input: TimelineDerive, observationId?: string) => Promise<TimelineMedia>;
export interface PerceptionRead {
  status: PerceptionStatus;
  result: ExecutionResult;
  snapshot?: PerceptionSnapshot;
  records?: PerceptionRecord[];
  query?: ObservationQuery;
  hasMore?: boolean;
  nextAfter?: number;
  reused?: boolean;
  error?: string;
  availability?: { persistent: boolean; hotSeconds: number;
    earliest: { sequence: number; recordedAt: string } | null;
    latest: { sequence: number; recordedAt: string } | null; expired: boolean };
}
/** One workspace process owns perception. Only explicit reload replaces it. */
export class PerceptionRuntime {
  private current: PerceptionStatus = { state: "unimplemented", generation: null };
  private worker?: PythonWorker;
  private lastReadIds: string[] = [];
  private transition: Promise<unknown> = Promise.resolve();
  private reading: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;
  private readonly clock: Clock;
  // Only identities for explicitly delivered images, keyed by the CLI's record marker.
  private deliveredMedia = new Map<string, TimelineMedia>();

  constructor(private readonly options: {
    workspace: string; runDir: string; env?: NodeJS.ProcessEnv; record: RecordEvent; clock?: Clock;
    registerMedia?: RegisterMedia; diagnostics?: DiagnosticsMode;
    startTimeoutMs?: number; observeTimeoutMs?: number;
  }) {
    this.workspace = resolve(options.workspace);
    this.clock = options.clock ?? { id: basename(options.runDir), now: () => performance.now() };
  }

  status(): PerceptionStatus { return { ...this.current }; }

  reload(trace: EventTrace = {}): Promise<PerceptionStatus> {
    const operation = this.transition.then(() => this.replace(trace));
    this.transition = operation.catch(() => {});
    return operation;
  }

  stop(): Promise<void> {
    const operation = this.transition.then(async () => {
      await this.closeWorker();
      this.setStatus({ ...this.current, state: "stopped", pid: undefined, error: undefined });
    });
    this.transition = operation.catch(() => {});
    return operation;
  }

  observe(signal: AbortSignal, parent: EventTrace = {}, query: ObservationQuery = {}): Promise<PerceptionRead> {
    const result = this.reading.then(() => this.read(signal, parent, query));
    this.reading = result.catch(() => {});
    return result;
  }

  async append(input: TimelineAppend, signal: AbortSignal): Promise<unknown> {
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Timeline recorder is unavailable; run rsa perception reload.");
    const reply = await this.request(worker, { ...input, action: "append" }, 30_000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    return reply.result;
  }

  async deriveMedia(input: TimelineDerive, signal: AbortSignal, observationId?: string): Promise<TimelineMedia> {
    const worker = this.worker;
    if (!worker || worker.expectedExit) throw new Error("Timeline recorder is unavailable; run rsa perception reload.");
    const reply = await this.request(worker, { ...input, action: "derive" }, 30_000, signal);
    if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
    const media = reply.result as TimelineMedia;
    this.options.registerMedia?.(media);
    if (observationId) {
      const key = `${observationId}\0${media.sha256}`;
      this.deliveredMedia.delete(key);
      this.deliveredMedia.set(key, media);
      if (this.deliveredMedia.size > 4096) this.deliveredMedia.delete(this.deliveredMedia.keys().next().value!);
    }
    return media;
  }

  deliveredMediaReference(sha256: string, observationId?: string): TimelineMedia | undefined {
    return observationId ? this.deliveredMedia.get(`${observationId}\0${sha256}`) : undefined;
  }

  private async read(signal: AbortSignal, parent: EventTrace, query: ObservationQuery): Promise<PerceptionRead> {
    const trace = childTrace(parent), started = this.clock.now();
    const observedStatus = this.status(), worker = this.worker;
    this.record("perception_observe_start", { status: observedStatus, query }, trace);
    try {
      signal.throwIfAborted();
      if (!worker || worker.expectedExit) return this.finish(this.unavailable(), started, trace);
      const reply = await this.request(worker, { action: "observe", query },
        this.options.observeTimeoutMs ?? 5000, signal);
      signal.throwIfAborted();
      if (!this.isCurrent(worker)) {
        return this.finish(this.unavailable("Perception generation stopped or was replaced during observation.",
          { ...observedStatus, state: "stopped" }), started, trace);
      }
      // A bad history query must not poison the running sampler's health.
      if (!reply.ok) return this.finish(this.unavailable(`${reply.error?.type}: ${reply.error?.message}`), started, trace);
      const value = reply.result as { records: Array<PerceptionSnapshot & {
        text: string; data?: unknown; space?: unknown;
        media: { path?: string; mediaType: string; data?: string; timeline?: Observation["timeline"] }[];
      }>; query: ObservationQuery; hasMore: boolean; nextAfter?: number; availability?: PerceptionRead["availability"] };
      if (!this.isCurrent(worker)) {
        return this.finish(this.unavailable("Perception generation stopped or was replaced during observation.",
          { ...observedStatus, state: "stopped" }), started, trace);
      }
      const records: PerceptionRecord[] = value.records.map(({ text, media, data, space, ...snapshot }) => ({
        snapshot, text, ...(data === undefined ? {} : { data }), ...(space === undefined ? {} : { space }),
        observations: media.map((item, index) => ({
          ...item, id: `${snapshot.id}-${index}`, controllerId: "perception",
          timing: { clock: snapshot.sampling.clock, requestedAtMs: snapshot.sampling.startedAtMs,
            receivedAtMs: snapshot.sampling.finishedAtMs },
        })),
      }));
      // The history store normalizes unused tool fields before choosing a mode.
      // Use the same canonical query when enforcing freshness across reloads.
      query = value.query;
      const latest = query.at === undefined && query.start === undefined && query.end === undefined
        && query.after === undefined && query.id === undefined;
      const mainLatest = latest && (!query.capability || query.capability === "python/perception.py:Perception.sample");
      // During reload/failure, latest must not silently serve an old generation as fresh.
      const currentRecords = mainLatest ? records.filter(record => record.snapshot.generation === worker.generation) : records;
      if (!currentRecords.length || (mainLatest && this.current.state !== "ready")) {
        const error = (mainLatest ? this.current.error : undefined) ?? (value.availability?.expired
          ? "Requested observation has expired from the non-persistent history window. See availability for the retained range."
          : latest ? "No sample available from the current generation yet." : "No observation at the requested time.");
        return this.finish({ ...this.unavailable(error), query, records: [], hasMore: false, availability: value.availability }, started, trace);
      }
      const snapshot = currentRecords.at(-1)!.snapshot;
      const ids = currentRecords.map(record => record.snapshot.id);
      const reused = ids.length === this.lastReadIds.length && ids.every((id, index) => id === this.lastReadIds[index]);
      this.lastReadIds = ids;
      const text = currentRecords.length === 1 ? currentRecords[0]!.text : currentRecords.map(record =>
        `[${record.snapshot.recordedAt} #${record.snapshot.sequence}]\n${record.text}`).join("\n\n");
      return this.finish({ status: this.status(),
        result: this.execution(text, currentRecords.flatMap(record => record.observations), started),
        snapshot, records: currentRecords, query: value.query, hasMore: value.hasMore, availability: value.availability,
        ...(value.nextAfter === undefined ? {} : { nextAfter: value.nextAfter }), reused }, started, trace);
    } catch (error) {
      if (signal.aborted) {
        const result = this.execution("", [], started, "Observation wait cancelled");
        result.status = "interrupted";
        this.record("perception_observe_end", { status: observedStatus, result, query, outcome: "cancelled",
          durationMs: this.clock.now() - started }, trace);
        throw signal.reason ?? error;
      }
      if (worker && !this.isCurrent(worker)) {
        return this.finish(this.unavailable("Perception generation stopped or was replaced during observation.",
          { ...observedStatus, state: "stopped" }), started, trace);
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(this.unavailable(message), started, trace);
    }
  }

  private async replace(trace: EventTrace): Promise<PerceptionStatus> {
    await this.closeWorker();
    this.lastReadIds = [];
    let source: Buffer | undefined;
    let sourceError: string | undefined;
    try { source = await readFile(join(this.workspace, "perception.py")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") sourceError = String(error);
    }
    const generation = crypto.randomUUID(), codeSHA = source ? createHash("sha256").update(source).digest("hex") : undefined;
    this.setStatus({ state: "loading", generation, codeSHA }, trace);
    const directory = join(this.options.runDir, "perception", generation);
    await mkdir(directory, { recursive: true });
    if (source) await writeFile(join(directory, "perception.py"), source);
    const backgroundTrace = childTrace({ recordingId: basename(this.options.runDir), recordingPurpose: "continuous-perception" });
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, RSA_WORKSPACE: this.workspace,
      RSA_RUN_ID: basename(this.options.runDir), RSA_LOG_DIAGNOSTICS: this.options.diagnostics ?? "normal",
      BASEWARE_TRACE: JSON.stringify(backgroundTrace) };
    for (const key of ["RSA_EPOCH", "RSA_TRACE", "BASEWARE_EPOCH"]) delete (env as NodeJS.ProcessEnv)[key];
    env.PYTHONPATH = [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
    const worker = new PythonWorker(generation, {
      executable: pythonExecutable(env), module: "rsa_tools._perception", workspace: this.workspace, env,
      stderrPath: join(directory, "stderr.log"),
      onEvent: reply => {
        // Expected exits still flush statistics and media registrations.
        if (this.worker !== worker) return;
        for (const media of reply.mediaReferences ?? []) this.options.registerMedia?.(media);
        if (reply.event === "status" && this.isCurrent(worker)) this.setStatus({ ...this.current, state: reply.state,
          error: typeof reply.error === "string" ? reply.error : undefined }, backgroundTrace, !reply.transient);
        if (reply.event === "recording" && reply.type) this.record(reply.type, reply.data, reply.trace ?? backgroundTrace, reply.channel, reply.origin);
      },
      onExit: error => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        if (!worker.expectedExit) this.setStatus({ ...this.current, state: "error", pid: undefined, error: error.message });
      },
    });
    this.worker = worker;
    // Background reads are rooted at this generation, not at the model call
    // that happened to reload it. Its status event makes that root discoverable.
    this.setStatus({ ...this.current, pid: worker.process.pid }, backgroundTrace);
    try {
      const reply = await this.request(worker, { action: "start", workspace: this.workspace,
        runDir: this.options.runDir, generation, source: source?.toString("utf8"), sourceError, trace: backgroundTrace,
        diagnostics: this.options.diagnostics ?? "normal" },
      this.options.startTimeoutMs ?? 30_000);
      if (!reply.ok) throw new Error(`${reply.error?.type}: ${reply.error?.message}`);
      const result = reply.result as { sampleHz?: number; history: PerceptionStatus["history"]; state: PerceptionStatus["state"]; error?: string };
      this.setStatus({ ...this.current, sampleHz: result.sampleHz, history: result.history,
        ...(this.current.state === "loading" ? { state: result.state, error: result.error } : {}) }, trace);
    } catch (error) {
      await this.closeWorker();
      this.setStatus({ ...this.current, state: "error", pid: undefined, error: String(error) }, trace);
    }
    return this.status();
  }

  private request(worker: PythonWorker, message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerReply> {
    return worker.request(message, timeoutMs, signal);
  }

  private async closeWorker() {
    const worker = this.worker;
    if (worker) await worker.stop();
  }

  private isCurrent(worker: PythonWorker) {
    return this.worker === worker && !worker.expectedExit && this.current.generation === worker.generation;
  }

  private unavailable(error = this.current.error ?? `Perception is ${this.current.state}.`, status = this.status()): PerceptionRead {
    return { status, result: this.execution(error, [], this.clock.now(), error), error };
  }

  private execution(text: string, observations: Observation[], started: number, error?: string): ExecutionResult {
    return { id: crypto.randomUUID(), status: error ? "failed" : "completed", exitCode: error ? 1 : 0,
      stdout: text, stderr: error ?? "", observations,
      timing: { clock: this.clock.id, requestedAtMs: started, receivedAtMs: this.clock.now() } };
  }

  private finish(read: PerceptionRead, started: number, trace: EventTrace) {
    // Cold video decoding produces new image bytes. Register their identity
    // against the same frame before a CLI/tool result can reach log archival.
    const media = (read.result.observations ?? []).flatMap(observation => {
      if (observation.data === undefined || !observation.timeline?.video) return [];
      const bytes = Buffer.from(observation.data, "base64");
      return [{ ...observation.timeline, sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length, mediaType: observation.mediaType, approximate: true }];
    });
    for (const reference of media) this.options.registerMedia?.(reference);
    this.record("perception_observe_end", { ...perceptionMetadata(read), outcome: read.error ? "error" : "success",
      durationMs: this.clock.now() - started }, trace);
    return read;
  }

  private setStatus(status: PerceptionStatus, trace?: EventTrace, persist = true) {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    if (persist) this.record("perception_status", status, trace);
  }

  private record(type: string, data: unknown, trace?: EventTrace, channel?: "diagnostic", origin?: EventMetadata["origin"]) {
    if (type.startsWith("perception_observe_") && (trace?.recordingPurpose === "continuous-action" || trace?.recordingPurpose === "continuous-perception")) channel = "diagnostic";
    if (channel === "diagnostic" && this.options.diagnostics !== "full") return;
    this.options.record(type, data, trace, { source: { component: "perception", implementation: "python" },
      ...(origin ? { origin } : {}), ...(channel ? { channel } : {}) });
  }
}

/** Events point at the axis; selected media bytes only live in delivery responses. */
export function observationMetadata({ data: _data, ...observation }: Observation): Observation { return observation; }

export function perceptionMetadata(read: PerceptionRead, includeData = false): PerceptionRead {
  return { ...read, result: { ...read.result, observations: read.result.observations?.map(observationMetadata) },
    records: read.records?.map(({ data: _data, space: _space, ...record }) => ({ ...record,
      ...(includeData ? { data: _data, space: _space } : {}),
      observations: record.observations.map(observationMetadata) })) };
}

export async function observationBytes(observation: Observation): Promise<Buffer> {
  if (observation.data !== undefined) return Buffer.from(observation.data, "base64");
  if (!observation.path) throw new Error(`Observation ${observation.id} has no retained media`);
  return readFile(observation.path);
}
