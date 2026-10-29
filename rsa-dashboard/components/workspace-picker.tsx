"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FolderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";

export function workspaceName(project?: Project, fallback = "") {
  if (!project) return fallback;
  if (project.name) return project.name;
  if (project.workspace) {
    const parts = project.workspace.split("/").filter(Boolean);
    return (parts.at(-1) === "workspace" ? parts.at(-2) : parts.at(-1)) ?? project.id;
  }
  return project.id;
}

/** A context selector only; the parent owns URL updates and run selection. */
export function WorkspacePicker({ projects, value, onChange, loading = false, error = "" }: {
  projects: Project[];
  value: string;
  onChange(project: string): void;
  loading?: boolean;
  error?: string;
}) {
  const id = useId();
  const t = useTranslations("workspacePicker");
  const dt = useTranslations("dashboard");
  const [open, setOpen] = useState(false);
  const selectedChoice = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusedChoice = useRef<HTMLButtonElement | null>(null);
  const selected = projects.find(project => project.id === value);
  const empty = !projects.length;
  const emptyMessage = loading ? t("loading") : error ? t("unavailable") : t("empty");
  const emptyHint = loading ? t("loading") : error ? t("errorHint") : t("emptyHint");
  useLayoutEffect(() => {
    // Catalog refreshes may remove the focused row; keep the dismissal reachable without selecting another item.
    const previous = focusedChoice.current;
    if (open && previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === content.current)) {
      focusedChoice.current = null;
      closeButton.current?.focus({ preventScroll: true });
    }
  }, [projects, open]);
  return <div className="topbar-workspace-picker flex min-w-0 max-w-full items-center gap-2">
    <Label id={`${id}-label`} htmlFor={id} className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <FolderIcon className="size-4" aria-hidden="true" />{dt("picker.workspace")}
    </Label>
    <Dialog open={open} onOpenChange={next => { if (!next || !empty) setOpen(next); }}>
      <DialogTrigger asChild>
        <Button id={id} type="button" variant="outline" size="sm" className="workspace-picker-trigger min-w-0 w-56 max-w-full shrink justify-between text-xs sm:w-64 aria-disabled:opacity-50"
          aria-disabled={empty} aria-labelledby={`${id}-label ${id}-value`} aria-describedby={`${id}-hint`}
          title={selected?.workspace ?? (empty ? emptyMessage : t("choose"))}>
          <span id={`${id}-value`} className="min-w-0 truncate">{empty ? emptyMessage : workspaceName(selected, t("choose"))}{selected?.available === false ? dt("picker.unavailable") : ""}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent ref={content} showCloseButton={false} className="workspace-picker-dialog flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={event => {
          event.preventDefault();
          const target = selectedChoice.current ?? closeButton.current;
          target?.focus({ preventScroll: true });
          selectedChoice.current?.scrollIntoView({ block: "nearest" });
        }}
        onFocusCapture={event => { focusedChoice.current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-workspace-choice]") : null; }}>
        <div className="workspace-picker-header">
          <DialogTitle>{t("choose")}</DialogTitle>
          <DialogClose asChild><Button ref={closeButton} type="button" variant="outline" size="sm">{t("close")}</Button></DialogClose>
        </div>
        <div className="workspace-picker-body">
          <DialogDescription className="workspace-picker-description">{t("description")}</DialogDescription>
          {empty ? <div className="workspace-picker-empty" role="status"><p>{emptyMessage}</p>{!loading && <p>{emptyHint}</p>}</div>
            : <ul className="workspace-picker-list" role="list" aria-label={t("choose")}>
              {projects.map(project => <li key={project.id}>
                <button type="button" className="workspace-picker-choice" data-workspace-choice={project.id}
                  ref={project.id === value ? selectedChoice : undefined} aria-current={project.id === value ? "true" : undefined}
                  onClick={() => { if (!open) return; setOpen(false); if (project.id !== value) onChange(project.id); }}>
                  <span className="workspace-picker-choice-heading"><strong>{workspaceName(project)}</strong><span className="workspace-picker-markers">
                    {project.id === value && <span className="workspace-picker-current">{t("current")}</span>}
                    {project.available === false && <span className="workspace-picker-unavailable">{t("directoryUnavailable")}</span>}
                  </span></span>
                  <code className="workspace-picker-location" data-workspace-identity={project.workspace ? "path" : "id"}>{project.workspace || project.id}</code>
                </button>
              </li>)}
            </ul>}
        </div>
      </DialogContent>
    </Dialog>
    <span id={`${id}-hint`} className="sr-only">{empty ? emptyHint : selected?.workspace || selected?.id || t("description")}</span>
  </div>;
}
