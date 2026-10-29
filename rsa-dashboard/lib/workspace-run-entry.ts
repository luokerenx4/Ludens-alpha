import type { Project } from "./types";

export type WorkspaceRunEntry = "loading-catalog" | "catalog-error" | "no-workspaces" | "workspace-unavailable" | "no-run" | "ready";

export function workspaceRunEntry({ catalogReady, catalogError, project, run }: {
  catalogReady: boolean;
  catalogError: string;
  project?: Project;
  run: string;
}): WorkspaceRunEntry {
  if (!catalogReady) return "loading-catalog";
  // A failed directory read cannot establish that no workspaces exist.
  if (!project) return catalogError ? "catalog-error" : "no-workspaces";
  if (project.available === false) return "workspace-unavailable";
  return run ? "ready" : "no-run";
}

/** Start these recovery journeys without stale run, epoch or evidence parameters. */
export function workspaceRunLinks(project: string | undefined, locale: "en" | "zh", benchmarkRun?: string) {
  const link = (params: Record<string, string>) => "/?" + new URLSearchParams(params);
  return {
    workspaces: link({ view: "workspaces" }),
    capabilities: project ? link({ view: "caps", project }) : undefined,
    quickstart: link({ view: "docs", doc: "tutorials/quickstart", docLang: locale }),
    benchmark: project && benchmarkRun ? link({ view: "benchmark", project, run: benchmarkRun }) : undefined,
  };
}
