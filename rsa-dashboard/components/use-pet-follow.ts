"use client";

import { useEffect, useRef, useState } from "react";
import type { PetState, PetTarget, PetTargetReceipt } from "../lib/pet";
import { createPetFollowResource, type PetFollowSnapshot } from "./pet-follow-resource";

async function request(signal: AbortSignal, init?: RequestInit): Promise<unknown> {
  const response = await fetch("/api/pet", { cache: "no-store", ...init, signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Pet request failed (${response.status})`);
  return value;
}

const target = (value: unknown): value is PetTarget | null => value === null || (typeof value === "object" && value !== null
  && ["project", "workspace", "revision", "updatedAt"].every(key => typeof (value as Record<string, unknown>)[key] === "string"));

async function readState(signal: AbortSignal): Promise<PetState> {
  const value = await request(signal) as PetState | null;
  if (!value || !target(value.target) || typeof value.targetConfigured !== "boolean" || ![true, false, null].includes(value.connected)
    || (value.consumer !== null && (typeof value.consumer !== "object" || !value.consumer))) throw new Error("Invalid pet status response");
  return value;
}

async function writeTarget(project: string | null, signal: AbortSignal): Promise<PetTargetReceipt> {
  const value = await request(signal, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }),
  }) as PetTargetReceipt | null;
  if (!value || !target(value.target) || (value.target?.project ?? null) !== project) throw new Error("Invalid pet target receipt");
  return value;
}

export function usePetFollow() {
  const [snapshot, setSnapshot] = useState<PetFollowSnapshot>({ state: null, pending: false, reading: true,
    readError: "", writeError: "", requested: undefined, lastReadAt: null, lastSaved: undefined, canWrite: false });
  const resource = useRef<ReturnType<typeof createPetFollowResource> | null>(null);
  useEffect(() => {
    const value = createPetFollowResource({
      read: readState,
      write: writeTarget,
      onChange: setSnapshot,
    });
    resource.current = value;
    void value.refresh();
    return () => { value.dispose(); if (resource.current === value) resource.current = null; };
  }, []);
  return { ...snapshot,
    follow: (project: string | null) => resource.current?.follow(project) ?? Promise.resolve(),
    refresh: () => { void resource.current?.refresh(); },
  };
}
export type PetFollow = ReturnType<typeof usePetFollow>;
