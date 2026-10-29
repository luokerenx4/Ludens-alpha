"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ReadState<T> {
  url: string;
  value?: T;
  error: string;
  loading: boolean;
}

/** A retryable GET whose cached value is separate from any editor draft or write. */
export function useReadResource<T>(url: string | null, fallback: string) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<ReadState<T> | null>(null);
  const request = useRef<AbortController | null>(null);
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const readFailure = useRef(fallback);
  readFailure.current = fallback;

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && currentUrl.current === url;
    setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined,
      error: previous?.url === url ? previous.error : "", loading: true }));
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? readFailure.current);
        if (isCurrent()) setLoaded({ url, value, error: "", loading: false });
      } catch (error) {
        if (isCurrent()) setLoaded(previous => ({ url, value: previous?.url === url ? previous.value : undefined,
          error: error instanceof Error ? error.message : String(error), loading: false }));
      }
    })();
    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [url, revision]);

  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setLoaded(previous => previous?.url === url ? { ...previous, loading: false } : previous);
  }, [url]);
  const retry = useCallback(() => {
    if (!url) return;
    cancel();
    setRevision(value => value + 1);
  }, [url, cancel]);
  // A successful mutation is authoritative. A pre-write GET may never replace it.
  const replace = useCallback((value: T) => {
    cancel();
    if (url) setLoaded({ url, value, error: "", loading: false });
  }, [url, cancel]);
  const current = loaded?.url === url ? loaded : null;
  return { value: current?.value, error: current?.error ?? "", loading: !!url && (!current || current.loading), retry, cancel, replace };
}
