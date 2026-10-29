import type { BenchmarkCatalog } from "./benchmarks";

export interface BenchmarkCatalogOwnership { project: string; workspace: string }
export type BenchmarkTaskMetadata = Pick<BenchmarkCatalog, "project" | "projects" | "tasks" | "issues">;
export interface BenchmarkMetadataSnapshot {
  owner: string;
  url: string;
  metadata: BenchmarkTaskMetadata;
}

export function benchmarkCatalogOwner(ownership: BenchmarkCatalogOwnership | null): string | null {
  return ownership?.project && ownership.workspace ? JSON.stringify([ownership.project, ownership.workspace]) : null;
}

/** Never retain history, paging cursors or a result selection with the task inventory. */
export function benchmarkTaskMetadata(catalog: BenchmarkCatalog, ownership: BenchmarkCatalogOwnership): BenchmarkTaskMetadata | null {
  if (catalog.project !== ownership.project || !catalog.projects.some(project => project.id === ownership.project && project.workspace === ownership.workspace)) return null;
  return { project: catalog.project, projects: catalog.projects, tasks: catalog.tasks, issues: catalog.issues };
}

export function retainedBenchmarkMetadata(snapshot: BenchmarkMetadataSnapshot | null, ownership: BenchmarkCatalogOwnership | null, url: string | null, error: string, currentUrlLoaded: boolean) {
  const current = url && snapshot?.owner === benchmarkCatalogOwner(ownership) ? snapshot : null;
  return { metadata: current?.metadata, metadataStale: !!current && (!currentUrlLoaded || current.url !== url || !!error) };
}
