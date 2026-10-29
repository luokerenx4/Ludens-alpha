"use client";
import { useEffect, useRef, useState } from "react";
import { ReadPoller } from "../lib/read-poller";
import { useTranslations } from "@/lib/locale";

interface BenchmarkReadOptions<T> {
  /** Distinguish an ownership change even when the endpoint URL stays the same. */
  identity?: string;
  /** Called only for the current reader, before committing. May reject an invalid response. */
  onValue?(value: T): void;
}

/** Pausing changes only the schedule. Explicit recovery performs one read in the same scope. */
export function useBenchmarkRead<T>(url: string | null, refresh = false, options: BenchmarkReadOptions<T> = {}) {
  const t = useTranslations("benchmarkCases");
  const identity = options.identity ?? "";
  const key = JSON.stringify([url, identity]);
  const fallback = useRef(t("loadFailed")); fallback.current = t("loadFailed");
  const enabled = useRef(refresh); enabled.current = refresh;
  const activeKey = useRef(key); activeKey.current = key;
  const onValue = useRef(options.onValue); onValue.current = options.onValue;
  const poller = useRef<{ key: string; reader: ReadPoller } | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; value?: T; error: string; loading: boolean } | null>(null);
  useEffect(() => {
    if (!url) return;
    const reader = new ReadPoller(async signal => {
      setLoaded(previous => ({ key, value: previous?.key === key ? previous.value : undefined,
        error: previous?.key === key ? previous.error : "", loading: true }));
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? fallback.current);
        if (!signal.aborted && activeKey.current === key) {
          onValue.current?.(value);
          setLoaded({ key, value, error: "", loading: false });
        }
      } catch (error) {
        if (!signal.aborted && activeKey.current === key) setLoaded(previous => ({ key,
          value: previous?.key === key ? previous.value : undefined, error: error instanceof Error ? error.message : String(error), loading: false }));
      }
      return 5000;
    }, enabled.current);
    poller.current = { key, reader }; void reader.readOnce();
    return () => { reader.dispose(); if (poller.current?.reader === reader) poller.current = null; };
  }, [url, key]);
  useEffect(() => { poller.current?.reader.setEnabled(refresh); }, [refresh]);
  const current = loaded?.key === key ? loaded : null;
  return { value: current?.value, error: current?.error ?? "", loading: !!url && (!current || current.loading),
    retry: () => { if (url && poller.current?.key === key) void poller.current.reader.readOnce(); } };
}
