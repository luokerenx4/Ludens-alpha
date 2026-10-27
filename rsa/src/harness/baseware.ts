import { BasewareClient } from "@playness/baseware/client";
import type { ExecutionResult } from "@playness/baseware/contracts";
import type { Catalog } from "@playness/baseware/protocol";
import type { RecordEvent, EventTrace } from "./events.ts";
import type { DeviceSession } from "./runtime.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EventSourceDescriptor, SourceDependency } from "../../../shared/event-sources.ts";

interface ControlStatus { mode: string; epoch: string | null; connected: boolean; remainingSeconds: number | null;
  source?: EventSourceDescriptor; seq?: number; diagnostics?: "normal" | "full" }

/** One persistent control connection; shell/API clients share its epoch. */
export async function connectBaseware(options: { socket: string; seconds: number; runDir: string; record: RecordEvent }) {
  let owner: string | undefined;
  let pendingOwner: string | undefined;
  let disconnected: Error | undefined;
  let onDisconnect: ((error: Error) => void) | undefined;
  let onHandback: ((reason: string) => void) | undefined;
  const recordingId = basename(options.runDir);
  const eventSources: SourceDependency[] = [];
  let dirty = false;
  let gap: { sourceId: string; firstSeq: number; lastSeq: number; count: number } | undefined;
  let gapWarning = false;
  const recordGap = (data: Record<string, unknown>) => {
    try { options.record("event_source_gap", data); }
    catch (error) {
      // Both journals may share a failed disk. Logging that failure must not
      // interrupt the control notification or fail an already delivered input.
      if (!gapWarning) { gapWarning = true; console.error(`Event source gap could not be recorded: ${String(error)}`); }
    }
  };
  const persistSources = () => {
    if (!dirty) return;
    const path = join(options.runDir, "manifest.json");
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const temporary = `${path}.sources.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...manifest, eventSources }, null, 2));
      renameSync(temporary, path);
      dirty = false;
    } catch (error) {
      // The initial manifest is written after connecting. A storage failure is
      // diagnostic, never a reason to retry an already delivered input.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Event source manifest: ${String(error)}`);
    }
  };
  const disconnect = (error: Error) => { if (disconnected) return; disconnected = error; onDisconnect?.(error); };
  const client = await BasewareClient.connect(options.socket, {
    onEvent(event) {
      // The device service owns its facts. RSA only keeps source dependencies
      // and consumes control notifications; it never appends a second body.
      const dependency = eventSources.find(source => source.sourceId === event.origin.clockId);
      if (dependency) {
        const window = dependency.windows.at(-1)!;
        if (event.origin.seq > (window.throughSeq ?? window.afterSeq)) { window.throughSeq = event.origin.seq; dirty = true; }
      }
      if (event.persisted === false) {
        if (!gap) {
          gap = { sourceId: event.origin.clockId, firstSeq: event.origin.seq, lastSeq: event.origin.seq, count: 0 };
          recordGap({ ...gap, phase: "start" });
        }
        gap.lastSeq = event.origin.seq; gap.count++;
      } else if (gap) {
        recordGap({ ...gap, phase: "end" }); gap = undefined;
      }
      if (event.type === "baseware_control") {
        const state = event.data as { mode: string; connected: boolean; reason?: string };
        if (state.mode === "manual" && (event.trace.epoch === owner || event.trace.epoch === pendingOwner)
          && typeof event.trace.epoch === "string") {
          owner = undefined;
          pendingOwner = undefined;
          onHandback?.(state.reason ?? "Baseware released control");
        }
        if (!state.connected) disconnect(new Error("Baseware driver disconnected"));
      }
      if (event.type === "baseware_disconnected") disconnect(new Error("Baseware driver disconnected"));
    },
    onDisconnect: disconnect,
  });
  try {
    const catalog = await client.request({ kind: "list" }) as Catalog;
    const initial = await client.request({ kind: "status" }) as ControlStatus;
    if (!initial.connected || disconnected) throw disconnected ?? new Error("Baseware driver disconnected");
    if (initial.source) eventSources.push({ ...initial.source, recordingId,
      windows: [{ afterSeq: initial.seq ?? 0, throughSeq: initial.seq ?? 0 }] });
    const watermark = setInterval(persistSources, 5000); watermark.unref();
    async function acquire(epoch: string) {
      pendingOwner = epoch;
      try {
        const state = await client.request({ kind: "acquire", epoch, seconds: options.seconds, trace: { recordingId } }) as ControlStatus;
        if (pendingOwner !== epoch || state.mode !== "auto" || state.epoch !== epoch || !state.connected
          || state.remainingSeconds === null || state.remainingSeconds <= 0) {
          throw new Error("Baseware control acquisition was revoked before completion");
        }
        owner = epoch;
      } finally { if (pendingOwner === epoch) pendingOwner = undefined; }
    }
    async function release(epoch: string) {
      if (owner !== epoch) return;
      owner = undefined;
      await client.request({ kind: "release", epoch, trace: { recordingId } });
    }
    const session: DeviceSession = {
      catalog, acquire, release, diagnostics: initial.diagnostics ?? "normal",
      async setInputGeneration(epoch, generation) {
        await client.request({ kind: "input_generation", epoch, generation, trace: { recordingId } });
      },
      async execute(id, args, epoch, signal, trace, origin) {
        const result = await client.request({ kind: "controller", id, arguments: args, epoch, trace: { ...trace, recordingId }, origin }, signal) as ExecutionResult;
        return result;
      },
    };
    return { ...session, eventSources,
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; if (disconnected) handler(disconnected); },
      onHandback(handler: (reason: string) => void) { onHandback = handler; },
      close() {
        clearInterval(watermark); persistSources();
        if (gap) { recordGap({ ...gap, phase: "end", reason: "host_closed" }); gap = undefined; }
        client.close();
      },
    };
  } catch (error) { client.close(); throw error; }
}
