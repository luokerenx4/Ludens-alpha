"use client";
import { useEffect, useRef, useState } from "react";
import { ReadPoller } from "../lib/read-poller";
import { useTranslations } from "@/lib/locale";

/** Pausing changes only the schedule. Explicit recovery performs one read in the same scope. */
export function useBenchmarkRead<T>(url: string | null, refresh = false) {
  const t = useTranslations("benchmarkCases");
  const fallback = useRef(t("loadFailed")); fallback.current = t("loadFailed");
  const enabled = useRef(refresh); enabled.current = refresh;
  const activeUrl = useRef(url); activeUrl.current = url;
  const poller = useRef<{ url: string; reader: ReadPoller } | null>(null);
  const [loaded, setLoaded] = useState<{ url: string; value?: T; error: string; loading: boolean } | null>(null);
  useEffect(() => {
    if (!url) return;
    const reader = new ReadPoller(async signal => {
      setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined,
        error: previous?.url === url ? previous.error : "", loading: true }));
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? fallback.current);
        if (!signal.aborted && activeUrl.current === url) setLoaded({ url, value, error: "", loading: false });
      } catch (error) {
        if (!signal.aborted && activeUrl.current === url) setLoaded(previous => ({ url,
          value: previous?.url === url ? previous.value : undefined, error: error instanceof Error ? error.message : String(error), loading: false }));
      }
      return 5000;
    }, enabled.current);
    poller.current = { url, reader }; void reader.readOnce();
    return () => { reader.dispose(); if (poller.current?.reader === reader) poller.current = null; };
  }, [url]);
  useEffect(() => { poller.current?.reader.setEnabled(refresh); }, [refresh]);
  const current = loaded?.url === url ? loaded : null;
  return { value: current?.value, error: current?.error ?? "", loading: !!url && (!current || current.loading),
    retry: () => { if (url && poller.current?.url === url) void poller.current.reader.readOnce(); } };
}
