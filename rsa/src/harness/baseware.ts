import { BasewareClient } from "@playness/baseware/client";
import type { ExecutionResult } from "@playness/baseware/contracts";
import type { Catalog } from "@playness/baseware/protocol";
import type { RecordEvent, EventTrace } from "./events.ts";
import type { DeviceSession } from "./runtime.ts";

interface ControlStatus { mode: string; epoch: string | null; connected: boolean; remainingSeconds: number | null }

/** One persistent control connection; shell/API clients share its epoch. */
export async function connectBaseware(options: { socket: string; seconds: number; runDir: string; record: RecordEvent }) {
  let owner: string | undefined;
  let pendingOwner: string | undefined;
  let disconnected: Error | undefined;
  let onDisconnect: ((error: Error) => void) | undefined;
  let onHandback: ((reason: string) => void) | undefined;
  const disconnect = (error: Error) => { if (disconnected) return; disconnected = error; onDisconnect?.(error); };
  const client = await BasewareClient.connect(options.socket, {
    onEvent(event) {
      // Device events retain identity and metadata. Only explicitly recorded
      // workspace perception owns permanent media; forwarding never copies it.
      options.record(event.type, event.data, event.trace as EventTrace, { source: event.source, origin: event.origin });
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
    async function acquire(epoch: string) {
      pendingOwner = epoch;
      try {
        const state = await client.request({ kind: "acquire", epoch, seconds: options.seconds }) as ControlStatus;
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
      await client.request({ kind: "release", epoch });
    }
    const session: DeviceSession = {
      catalog, acquire, release,
      async execute(id, args, epoch, signal, trace, origin) {
        const result = await client.request({ kind: "controller", id, arguments: args, epoch, trace: { ...trace }, origin }, signal) as ExecutionResult;
        return result;
      },
    };
    return { ...session,
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; if (disconnected) handler(disconnected); },
      onHandback(handler: (reason: string) => void) { onHandback = handler; },
      close() { client.close(); },
    };
  } catch (error) { client.close(); throw error; }
}
