"use client";

import { useId } from "react";
import { FolderIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
  const selected = projects.find(project => project.id === value);
  const empty = !projects.length;
  const emptyMessage = loading ? t("loading") : error ? t("unavailable") : t("empty");
  return <div className="topbar-workspace-picker flex min-w-0 max-w-full items-center gap-2">
    <Label htmlFor={id} className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <FolderIcon className="size-4" aria-hidden="true" />{dt("picker.workspace")}
    </Label>
    <NativeSelect id={id} size="sm" wrapperClassName="w-56 max-w-full sm:w-64" className="text-xs"
      value={selected?.id ?? ""} disabled={empty} aria-describedby={empty ? `${id}-hint` : undefined}
      title={selected?.workspace ?? (empty ? emptyMessage : t("choose"))}
      onChange={event => onChange(event.target.value)}>
      {empty ? <NativeSelectOption value="">{emptyMessage}</NativeSelectOption>
        : !selected ? <NativeSelectOption value="" disabled>{t("choose")}</NativeSelectOption> : null}
      {projects.map(project => <NativeSelectOption key={project.id} value={project.id}>
        {workspaceName(project)}{project.available === false ? dt("picker.unavailable") : ""}
      </NativeSelectOption>)}
    </NativeSelect>
    {empty ? <span id={`${id}-hint`} className="sr-only">{loading ? t("loading") : error ? t("errorHint") : t("emptyHint")}</span> : null}
  </div>;
}
