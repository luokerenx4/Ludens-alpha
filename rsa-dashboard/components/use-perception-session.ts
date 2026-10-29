"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PerceptionSettingsPatch } from "../lib/perception-config";
import { createPerceptionSession, EMPTY_PERCEPTION_SESSION, type PerceptionSession, type SavedPerception } from "./perception-draft";

const sessions = new Map<string, PerceptionSession>();
const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY_PERCEPTION_SESSION;
export function usePerceptionSession(project: string, workspace: string) {
  const scope = JSON.stringify([project, workspace]);
  const [active, setActive] = useState<{ scope: string; session: PerceptionSession } | null>(null);
  useEffect(() => {
    let session = sessions.get(scope);
    if (!session) {
      let storage: Storage | undefined;
      try { storage = window.sessionStorage; } catch { /* In-memory recovery remains available. */ }
      const url = "/api/perception-config?" + new URLSearchParams({ project, workspace });
      const request = async (patch?: PerceptionSettingsPatch, signal?: AbortSignal): Promise<SavedPerception> => {
        const response = await fetch(url, { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(25000),
          ...(patch ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) } : {}) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
        return value;
      };
      session = createPerceptionSession({ scope, storage, read: signal => request(undefined, signal), write: patch => request(patch) });
      sessions.set(scope, session);
    }
    setActive({ scope, session });
    void session.refresh();
  }, [scope, project, workspace]);
  const session = active?.scope === scope ? active.session : null;
  const subscribe = useCallback((listener: () => void) => session ? session.subscribe(listener) : emptySubscribe(), [session]);
  const state = useSyncExternalStore(subscribe, session?.snapshot ?? emptySnapshot, emptySnapshot);
  return { state, session };
}
