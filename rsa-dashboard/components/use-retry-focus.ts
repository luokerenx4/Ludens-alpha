"use client";

import { useEffect, useRef } from "react";

/** Restore focus only when a focused retry control disappears after recovery. */
export function useRetryFocus(loading: boolean, error?: string) {
  const target = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement | null>(null);
  const remember = (control: HTMLButtonElement) => {
    retry.current = document.activeElement === control ? control : null;
  };

  useEffect(() => {
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !retry.current?.contains(event.target)) retry.current = null;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release);
    return () => {
      document.removeEventListener("focusin", release);
      document.removeEventListener("pointerdown", release);
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const control = retry.current;
    retry.current = null;
    if (!error && control && !control.isConnected && document.activeElement === document.body) {
      target.current?.focus({ preventScroll: true });
    }
  }, [loading, error]);

  return { target, remember };
}
