import type { Project } from "./types";

export const latestGameRun = (project: Project | undefined) =>
  project?.runs.find((run) => run.kind !== "benchmark" && !run.benchmark);

export function initialSelection(search: string, projects: Project[]) {
  const query = new URLSearchParams(search);
  const project =
    projects.find((p) => p.id === query.get("project")) ??
    projects.find((p) => p.workspace && p.workspace === query.get("workspace"));
  if (!project)
    return {
      project:
        (projects.find((p) => latestGameRun(p)) ?? projects[0])?.id ?? "",
      run: "",
      epoch: "",
    };
  const requestedRun = query.get("run");
  const run = project.runs.find((r) => r.id === requestedRun)?.id ?? "";
  return {
    project: project.id,
    run,
    // A cycle from a missing run must not be applied to the fallback run.
    epoch: requestedRun && !run ? "" : (query.get("epoch") ?? ""),
  };
}
