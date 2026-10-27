import { createServer, connect } from "node:net";
import { lstat, unlink } from "node:fs/promises";
import type { Runtime } from "./runtime.ts";
import { childTrace, type EventTrace, type EventMetadata } from "./events.ts";
import { observationMetadata, type ObservationQuery, type TimelineAppend, type TimelineDerive } from "./perception.ts";
import type { ExecutionResult } from "@playness/baseware/contracts";

export interface Request {
  kind: string; argv: string[]; epoch?: string; runId?: string; expectedEpoch?: string | null;
  action?: "list" | "help" | "call" | "append" | "derive"; id?: string; arguments?: unknown; trace?: EventTrace;
  sample?: unknown; identity?: TimelineAppend["identity"]; sampling?: TimelineAppend["sampling"]; generation?: string | null;
  query?: ObservationQuery;
  media?: TimelineDerive;
  event?: { type: "python_call_start" | "python_call_end"; data: { id: string; [key: string]: unknown }; origin: EventMetadata["origin"]; channel?: "diagnostic" };
}
type Response = { ok: true; value: unknown } | { ok: false; error: string };

export async function listen(path: string, runtime: Runtime | (() => Runtime)) {
  // A killed host can leave a Unix socket behind. Never remove a live host's socket.
  try {
    if (!(await lstat(path)).isSocket()) throw new Error(`Not a Unix socket: ${path}`);
    await new Promise<void>((resolve, reject) => {
      const probe = connect(path);
      probe.once("connect", () => { probe.destroy(); reject(new Error(`Host already running: ${path}`)); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve(); else reject(error);
      });
    });
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createServer((socket) => {
    let buffer = "";
    let dispatched = false;
    let completed = false;
    const cancellation = new AbortController();
    socket.once("close", () => { if (!completed) cancellation.abort(new Error("Controller client disconnected")); });
    socket.setEncoding("utf8");
    socket.on("error", () => {}); // A CLI can disappear while management cleanup finishes.
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0 || dispatched) return;
      dispatched = true;
      void (async () => {
        let response: Response;
        try {
          const request: Request = JSON.parse(buffer.slice(0, end));
          response = { ok: true, value: await dispatch(typeof runtime === "function" ? runtime() : runtime, request, cancellation.signal) };
        } catch (error) { response = { ok: false, error: String(error) }; }
        completed = true;
        if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n");
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function dispatch(runtime: Runtime, request: Request, signal = new AbortController().signal): Promise<unknown> {
  const { kind, argv, epoch } = request;
  // Completed records may arrive late; fresh calls and management must belong
  // to the still-running program, even when its parent epoch has not changed.
  if (kind !== "workspace_event" && kind !== "timeline") runtime.checkInputGeneration(epoch, request.trace);
  if (kind === "status") return runtime.status();
  if (kind === "action") {
    if (!runtime.action) throw new Error("Action runtime is not configured");
    const status = runtime.status();
    if (epoch !== undefined && (status.mode !== "auto" || status.epoch !== epoch)) throw new Error("STALE_EPOCH: use the current control epoch");
    if (argv.length === 1 && argv[0] === "status") return runtime.action.status();
    if (argv.length === 1 && argv[0] === "reload") return runtime.action.reload(status.epoch ?? undefined);
    if (argv.length === 1 && argv[0] === "stop") return runtime.action.stop();
    throw new Error("Usage: rsa action status|reload|stop");
  }
  if (kind === "timeline") {
    if (!runtime.perception) throw new Error("Timeline recorder is unavailable; run rsa perception reload.");
    if (request.action === "derive") {
      if (!request.media) throw new Error("Timeline derive requires encoded media and its recorded source");
      const modelMedia = await runtime.perception.deriveMedia(request.media, signal, request.id);
      runtime.record("observation_media", { observationId: request.id, modelMedia,
        modelBytes: modelMedia.bytes, mimeType: modelMedia.mediaType }, request.trace);
      return modelMedia;
    }
    if (request.action !== "append" || !request.identity || typeof request.identity.id !== "string" || !request.sampling)
      throw new Error("Timeline append requires a recorded capability result, capability identity and sampling interval");
    // Recording a completed observation does not acquire control. Device input
    // retains its independent epoch checks, including for background programs.
    return runtime.perception.append({ sample: request.sample, identity: request.identity,
      sampling: request.sampling, generation: request.generation,
      runId: request.runId ?? runtime.status().runId, trace: request.trace }, signal);
  }
  if (kind === "perception") {
    if (!runtime.perception) throw new Error("Perception is not configured");
    if (epoch !== undefined && (runtime.status().mode !== "auto" || runtime.status().epoch !== epoch))
      throw new Error("STALE_EPOCH: use the current control epoch");
    const trace = childTrace({ ...request.trace, ...(epoch ? { epoch } : {}) });
    if (argv.length !== 1) throw new Error("Usage: rsa perception status|reload|stop|observe");
    if (argv[0] === "status") return runtime.perception.status();
    if (argv[0] === "reload") return runtime.perception.reload(trace);
    if (argv[0] === "stop") { await runtime.perception.stop(); return runtime.perception.status(); }
    if (argv[0] === "observe") return runtime.perception.observe(signal, trace, request.query);
    throw new Error("Usage: rsa perception status|reload|stop|observe");
  }
  if (kind === "workspace_event") {
    if (request.runId !== runtime.status().runId) throw new Error("STALE_RUN: Python log belongs to a different run");
    const event = request.event;
    if (!event || !["python_call_start", "python_call_end"].includes(event.type) || typeof event.data?.id !== "string" || !event.origin)
      throw new Error("Invalid workspace Python event");
    // Late completions keep their originating epoch, even after handback.
    if (event.channel !== "diagnostic" || runtime.diagnostics === "full")
      runtime.record(event.type, event.data, { ...request.trace, ...(epoch ? { epoch } : {}) }, {
        source: { component: "workspace", implementation: "python" }, origin: event.origin,
        ...(event.channel ? { channel: event.channel } : {}),
      });
    return null;
  }
  if (kind === "controller") {
    // One span owns the public call, including rejected calls. The Python
    // runner reuses it; the entry function and nested calls have child spans.
    const continuous = request.trace?.recordingPurpose === "continuous-perception" || request.trace?.recordingPurpose === "continuous-action";
    const parent = { ...request.trace, recordingId: runtime.status().runId, ...(epoch ? { epoch } : {}) };
    const trace = continuous && runtime.diagnostics === "normal" ? parent : childTrace(parent);
    const record = (type: string, data: unknown) => {
      if (!continuous || runtime.diagnostics === "full") runtime.record(type, data, trace, continuous ? { channel: "diagnostic" } : undefined);
    };
    const started = performance.now();
    const operation = { action: request.action, id: request.id };
    record("capability_start", { ...operation, ...(request.arguments !== undefined ? { arguments: request.arguments } : {}) });
    try {
      if (!runtime.controller) throw new Error("Workspace controller is unavailable");
      let value: unknown;
      if (request.action === "list") value = await runtime.controller.list(signal, trace);
      else {
        if (!request.id) throw new Error("Missing capability ID; see rsa controller --help");
        if (request.action === "help") value = await runtime.controller.help(request.id, signal, trace);
        else if (request.action === "call") value = await runtime.callController(request.id, request.arguments, epoch, signal, trace);
        else throw new Error("Unknown controller action; see rsa controller --help");
      }
      // Driver failures are successful RPC replies with a nonzero exitCode.
      const execution = request.action === "call" && request.id?.startsWith("controller/")
        ? value as ExecutionResult : undefined;
      const outcome = signal.aborted || execution?.status === "interrupted" ? "cancelled"
        : execution?.exitCode || execution?.status === "failed" ? "error" : "success";
      record("capability_end", { ...operation, outcome, durationMs: performance.now() - started,
        ...(execution ? { executionId: execution.id, controllerId: request.id?.slice("controller/".length),
          exitCode: execution.exitCode, status: execution.status,
          observations: execution.observations?.map(observationMetadata) } : {}) });
      return value;
    } catch (error) {
      record("capability_end", { ...operation,
        outcome: signal.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "error",
        durationMs: performance.now() - started, error: String(error) });
      throw error;
    }
  }
  if (kind === "auto" || kind === "consolidate") {
    if (epoch !== undefined) throw new Error("Control management belongs to the human, not an agent cycle");
    const status = runtime.status();
    if (request.runId !== status.runId) throw new Error("STALE_RUN: refresh the host status before changing control");
    if (request.expectedEpoch !== undefined && request.expectedEpoch !== status.epoch) throw new Error("STALE_EPOCH: the control cycle changed");
    if (kind === "consolidate") {
      if (argv.length === 0) return runtime.consolidate();
      if (argv.length === 2 && argv[0] === "--seconds") return runtime.consolidate(Number(argv[1]));
      throw new Error("Usage: rsa consolidate [--seconds <n>]");
    }
    if (argv.length === 1 && argv[0] === "on") return runtime.start();
    if (argv.length === 3 && argv[0] === "on" && argv[1] === "--message" && argv[2]?.trim()) return runtime.start(argv[2]);
    if (argv.length === 1 && argv[0] === "off") { await runtime.stop(); return runtime.status(); }
    throw new Error("Usage: rsa auto on [--message <text>] | rsa auto off");
  }
  throw new Error("Unknown command; see rsa --help");
}

export function send(path: string, request: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let complete = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.on("close", () => { if (!complete) reject(new Error("Host disconnected before replying")); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0 || complete) return;
      complete = true;
      socket.end();
      try {
        const response: Response = JSON.parse(buffer.slice(0, end));
        if (response.ok) resolve(response.value);
        else reject(new Error(response.error));
      } catch (error) { reject(error); }
    });
  });
}
