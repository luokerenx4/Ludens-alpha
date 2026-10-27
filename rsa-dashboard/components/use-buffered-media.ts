"use client";

import { useEffect, useMemo, useState } from "react";
import { ImageBuffer, type BufferedImage } from "./image-buffer";

export type MediaFrame<T> = { key: string; value: T; urls: string[] };
type ReadyFrame<T> = MediaFrame<T> & { images: Map<string, BufferedImage> };

/** Retain the displayed frame until every image of the target has decoded. */
export function useBufferedMedia<T>(scope: string, target: MediaFrame<T> | null, future: string[] = [], hold = false) {
  const buffer = useMemo(() => new ImageBuffer(), [scope]);
  const [state, setState] = useState<{ buffer: ImageBuffer; frame: ReadyFrame<T> } | null>(null);
  const displayed = state?.buffer === buffer && (target || hold) ? state.frame : null;
  const pending = !!target && displayed?.key !== target.key;
  const futureKey = JSON.stringify(future.slice(0, 8));
  const prefetch = useMemo<string[]>(() => JSON.parse(futureKey), [futureKey]);

  useEffect(() => () => buffer.clear(), [buffer]);
  useEffect(() => {
    if (!target) { if (!hold) setState(null); return; }
    let current = true;
    void buffer.prepare(target.urls).then(images => {
      if (current) setState({ buffer, frame: { ...target, images } });
    });
    return () => { current = false; };
  }, [buffer, target, hold]);

  useEffect(() => {
    const required = [...(displayed?.urls ?? []), ...(target?.urls ?? [])];
    buffer.retain([...required, ...prefetch]);
    if (pending || hold) return; // Current frame has priority over speculative I/O.
    let current = true;
    void (async () => {
      // Two requests at a time; seeks/unmounts cancel and release obsolete entries.
      for (let i = 0; i < prefetch.length && current; i += 2) {
        await buffer.prepare(prefetch.slice(i, i + 2));
        if (current) buffer.trimPrefetch(required);
      }
    })();
    return () => { current = false; };
  }, [buffer, displayed, target, prefetch, pending, hold]);
  return { displayed, pending };
}
