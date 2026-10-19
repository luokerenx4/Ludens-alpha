import type { Project } from "./types";

export function initialSelection(search: string, projects: Project[]) {
  const query = new URLSearchParams(search);
  const project =
    projects.find((p) => p.id === query.get("project")) ??
    projects.find((p) => p.workspace && p.workspace === query.get("workspace"));
  if (!project) return { project: projects[0]?.id ?? "", run: "", epoch: "" };
  const requestedRun = query.get("run");
  const run = project.runs.find((r) => r.id === requestedRun)?.id ?? "";
  return {
    project: project.id,
    run,
    // A cycle from a missing run must not be applied to the fallback run.
    epoch: requestedRun && !run ? "" : (query.get("epoch") ?? ""),
  };
}
