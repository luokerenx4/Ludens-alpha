import { BasewareClient } from "@playness/baseware/client";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, constants } from "node:fs";
import { extname, join } from "node:path";
import type { Observation, ExecutionResult } from "@playness/baseware/contracts";
import type { Catalog } from "@playness/baseware/protocol";
import type { RecordEvent, EventTrace } from "./events.ts";
import type { DeviceSession } from "./runtime.ts";

interface ControlStatus { mode: string; epoch: string | null; connected: boolean; remainingSeconds: number | null }

/** One persistent control connection; shell/API clients share its epoch. */
export async function connectBaseware(options: { socket: string; seconds: number; runDir: string; record: RecordEvent }) {
  const observationsDir = join(options.runDir, "observations");
  mkdirSync(observationsDir, { recursive: true });
  let owner: string | undefined;
  let pendingOwner: string | undefined;
  let disconnected: Error | undefined;
  let onDisconnect: ((error: Error) => void) | undefined;
  let onHandback: ((reason: string) => void) | undefined;
  const localPath = (observation: Observation) => {
    const identity = createHash("sha256").update(JSON.stringify([observation.sensorId, observation.id, observation.path])).digest("hex");
    return join(observationsDir, `${identity}${extname(observation.path)}`);
  };
  const disconnect = (error: Error) => { if (disconnected) return; disconnected = error; onDisconnect?.(error); };
  const client = await BasewareClient.connect(options.socket, {
    onEvent(event) {
      if (event.type === "observation") {
        const observation = event.data as Observation;
        const path = localPath(observation);
        // Keep each RSA run self-contained for Dashboard/Pet and later review.
        // COPYFILE_FICLONE uses a copy-on-write clone where the filesystem supports it.
        copyFileSync(observation.path, path, constants.COPYFILE_FICLONE);
        event = { ...event, data: { ...observation, path } };
      }
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
      async execute(id, argv, epoch, signal, trace) {
        return await client.request({ kind: "controller", id, argv, epoch, trace: { ...trace } }, signal) as ExecutionResult;
      },
      async observe(request, signal, trace, origin) {
        const observations = await client.request({ kind: "sensor", id: request.sensorId, argv: request.argv, epoch: owner, trace: { ...trace }, origin }, signal) as Observation[];
        return observations.map(observation => ({ ...observation, path: localPath(observation) }));
      },
    };
    return { ...session,
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; if (disconnected) handler(disconnected); },
      onHandback(handler: (reason: string) => void) { onHandback = handler; },
      close() { client.close(); },
    };
  } catch (error) { client.close(); throw error; }
}
