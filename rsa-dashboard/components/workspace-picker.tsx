"use client";

import { FolderIcon } from "lucide-react";
import { ContextPicker } from "@/components/context-picker";
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
  const t = useTranslations("workspacePicker");
  const dt = useTranslations("dashboard");
  const selected = projects.find(project => project.id === value);
  const empty = !projects.length;
  const emptyMessage = loading ? t("loading") : error ? t("unavailable") : t("empty");
  const emptyHint = loading ? t("loading") : error ? t("errorHint") : t("emptyHint");
  return <ContextPicker kind="workspace" value={value} onChange={onChange}
    label={<><FolderIcon className="size-4" aria-hidden="true" />{dt("picker.workspace")}</>}
    options={projects.map(project => ({ value: project.id, label: workspaceName(project),
      identity: project.workspace || project.id, identityKind: project.workspace ? "path" : "id",
      badge: project.available === false ? t("directoryUnavailable") : undefined }))}
    trigger={{ text: (empty ? emptyMessage : workspaceName(selected, t("choose"))) + (selected?.available === false ? dt("picker.unavailable") : ""),
      title: selected?.workspace ?? (empty ? emptyMessage : t("choose")),
      hint: empty ? emptyHint : selected?.workspace || selected?.id || t("description") }}
    copy={{ title: t("choose"), description: t("description"), close: t("close"), current: t("current"),
      empty: emptyMessage, emptyHint: loading ? undefined : emptyHint }} />;
}
