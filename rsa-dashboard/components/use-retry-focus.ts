"use client";

import { useEffect, useRef } from "react";

/** Restore focus only when a focused retry control disappears after recovery. */
export function useRetryFocus<T extends HTMLElement = HTMLDivElement>(loading: boolean, error?: string, scope?: string) {
  const target = useRef<T>(null);
  const retry = useRef<{ control: HTMLButtonElement; scope: string | undefined } | null>(null);
  const currentScope = useRef(scope);
  // A route change consumes the old intent even while reading, including A → B → A.
  if (currentScope.current !== scope) {
    currentScope.current = scope;
    retry.current = null;
  }
  const remember = (control: HTMLButtonElement) => {
    retry.current = document.activeElement === control ? { control, scope } : null;
  };

  useEffect(() => {
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !retry.current?.control.contains(event.target)) retry.current = null;
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
    const intent = retry.current;
    retry.current = null;
    if (!error && intent && intent.scope === scope && !intent.control.isConnected && document.activeElement === document.body) {
      target.current?.focus({ preventScroll: true });
    }
  }, [loading, error, scope]);

  return { target, remember };
}
