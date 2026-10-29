"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export interface ContextOption {
  value: string;
  label: string;
  identity?: string;
  identityKind?: "path" | "id";
  secondarySummary?: string;
  badge?: string;
}

/** Presentation only: callers own identity, catalog state, and navigation. */
export function ContextPicker({ kind, options, value, onChange, label, hideLabel = false, trigger, copy }: {
  kind: "workspace" | "run";
  options: ContextOption[];
  value: string;
  onChange(value: string): void;
  label: ReactNode;
  hideLabel?: boolean;
  trigger: { text: string; hint: string; title: string };
  copy: { title: string; description: string; close: string; current: string; empty: string; emptyHint?: string };
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selectedChoice = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusedChoice = useRef<HTMLButtonElement | null>(null);
  const empty = !options.length;
  useLayoutEffect(() => {
    // A catalog refresh may remove the focused row; do not select another item or refocus on ordinary polls.
    const previous = focusedChoice.current;
    if (open && previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === content.current)) {
      focusedChoice.current = null;
      closeButton.current?.focus({ preventScroll: true });
    }
  }, [options, open]);
  return <div className={`topbar-${kind}-picker context-picker flex min-w-0 max-w-full items-center gap-2`}>
    <Label id={`${id}-label`} htmlFor={id} className={hideLabel ? "sr-only" : "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"}>{label}</Label>
    <Dialog open={open} onOpenChange={next => { if (!next || !empty) setOpen(next); }}>
      <DialogTrigger asChild>
        <Button id={id} type="button" variant="outline" size="sm"
          className={`context-picker-trigger ${kind}-picker-trigger min-w-0 max-w-full shrink justify-between text-xs aria-disabled:opacity-50 ${kind === "workspace" ? "w-56 sm:w-64" : "w-60"}`}
          aria-disabled={empty} aria-labelledby={`${id}-label ${id}-value`} aria-describedby={`${id}-hint`} title={trigger.title}>
          <span id={`${id}-value`} className="min-w-0 truncate">{trigger.text}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent ref={content} showCloseButton={false} className={`context-picker-dialog ${kind}-picker-dialog flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl`}
        onOpenAutoFocus={event => {
          event.preventDefault();
          (selectedChoice.current ?? closeButton.current)?.focus({ preventScroll: true });
          selectedChoice.current?.scrollIntoView({ block: "nearest" });
        }}
        onFocusCapture={event => { focusedChoice.current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-context-choice]") : null; }}>
        <div className={`context-picker-header ${kind}-picker-header`}>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogClose asChild><Button ref={closeButton} type="button" variant="outline" size="sm">{copy.close}</Button></DialogClose>
        </div>
        <div className={`context-picker-body ${kind}-picker-body`}>
          <DialogDescription className={`context-picker-description ${kind}-picker-description`}>{copy.description}</DialogDescription>
          {empty ? <div className={`context-picker-empty ${kind}-picker-empty`} role="status"><p>{copy.empty}</p>{copy.emptyHint && <p>{copy.emptyHint}</p>}</div>
            : <ul className={`context-picker-list ${kind}-picker-list`} role="list" aria-label={copy.title}>
              {options.map(option => <li key={option.value}>
                <button type="button" className={`context-picker-choice ${kind}-picker-choice`} data-context-choice={option.value}
                  data-workspace-choice={kind === "workspace" ? option.value : undefined} data-run-choice={kind === "run" ? option.value : undefined}
                  ref={option.value === value ? selectedChoice : undefined} aria-current={option.value === value ? "true" : undefined}
                  onClick={() => { if (!open) return; setOpen(false); if (option.value !== value) onChange(option.value); }}>
                  <span className={`context-picker-choice-heading ${kind}-picker-choice-heading`}>
                    <strong className={`${kind}-picker-summary`}>{option.label}</strong>
                    <span className={`context-picker-markers ${kind}-picker-markers`}>
                      {option.value === value && <span className={`context-picker-current ${kind}-picker-current`}>{copy.current}</span>}
                      {option.badge && <span className={`context-picker-badge ${kind === "workspace" ? "workspace-picker-unavailable" : "run-picker-badge"}`}>{option.badge}</span>}
                    </span>
                  </span>
                  {option.secondarySummary && <span className={`context-picker-secondary ${kind}-picker-secondary`}>{option.secondarySummary}</span>}
                  {option.identity && <code className={`context-picker-identity ${kind === "workspace" ? "workspace-picker-location" : "run-picker-identity"}`}
                    data-workspace-identity={kind === "workspace" ? option.identityKind : undefined}>{option.identity}</code>}
                </button>
              </li>)}
            </ul>}
        </div>
      </DialogContent>
    </Dialog>
    <span id={`${id}-hint`} className="sr-only">{trigger.hint}</span>
  </div>;
}
