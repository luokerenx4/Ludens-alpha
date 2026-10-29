import type { DiscoveredDriver } from "../lib/drivers";
import type { CreateWorkspaceInput } from "../lib/workspaces";

export type WorkspaceEnvironment = "desktop" | "community";
export interface WorkspaceDraft {
  name: string;
  targetDirectory: string;
  environment: WorkspaceEnvironment;
  driverPackage: string;
  game: string;
  cuaCommand: string;
}
export const emptyWorkspaceDraft: WorkspaceDraft = {
  name: "", targetDirectory: "", environment: "desktop", driverPackage: "", game: "", cuaCommand: "",
};

export type WorkspaceCreationIntent = { driverPackage: string; driver?: DiscoveredDriver };

/** URL prefill is only an address; verification can come only from the in-memory discovery result. */
export function initialWorkspaceSetup(intent?: WorkspaceCreationIntent | null) {
  const spec = intent?.driverPackage.trim() ?? "";
  return {
    draft: { ...emptyWorkspaceDraft, ...(spec ? { environment: "community" as const, driverPackage: spec } : {}) },
    driver: spec && intent?.driver?.spec === spec ? intent.driver : null,
  };
}

/** Match the local host's POSIX path normalization without importing Node in the form. */
export function normalizedWorkspacePath(value: string): string | null {
  const path = value.trim();
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") segments.pop();
    else if (part && part !== ".") segments.push(part);
  }
  return "/" + segments.join("/");
}

export function workspaceLocation(defaultRoot: string, draft: Pick<WorkspaceDraft, "name" | "targetDirectory">) {
  const custom = draft.targetDirectory.trim().length > 0;
  const path = normalizedWorkspacePath(custom ? draft.targetDirectory : `${defaultRoot}/${draft.name.trim()}`);
  const name = custom ? path?.split("/").at(-1) ?? "" : draft.name.trim();
  return { path, name, custom };
}

export function switchWorkspaceEnvironment(draft: WorkspaceDraft, environment: WorkspaceEnvironment): WorkspaceDraft {
  return { ...draft, environment, game: "", cuaCommand: "" };
}

export function workspaceDriverCapabilities(environment: WorkspaceEnvironment, driver: DiscoveredDriver | null) {
  const stdio = environment === "desktop" || driver?.transport === "stdio";
  return {
    stdio,
    supportsGame: environment === "community" && !stdio && !!driver?.launchCommand?.length,
    missingPort: environment === "community" && !!driver && !stdio && driver.defaultPort === undefined,
  };
}

export type WorkspaceSetupIssue = {
  field: "name" | "targetDirectory" | "driverPackage";
  message: "invalidName" | "invalidDirectory" | "packageRequired" | "verifyFirst" | "unsupportedBridge";
};
export function workspaceCreateInput(defaultRoot: string, draft: WorkspaceDraft, driver: DiscoveredDriver | null):
  { ok: true; input: CreateWorkspaceInput } | { ok: false; issue: WorkspaceSetupIssue } {
  const location = workspaceLocation(defaultRoot, draft);
  if (location.custom && (!location.path || location.path === "/" || draft.targetDirectory.length > 2000)) {
    return { ok: false, issue: { field: "targetDirectory", message: "invalidDirectory" } };
  }
  if (!location.name || location.name === "." || location.name === ".." || /[\\/\0]/.test(location.name) || location.name.length > 120) {
    return { ok: false, issue: { field: location.custom ? "targetDirectory" : "name", message: "invalidName" } };
  }
  const spec = draft.driverPackage.trim();
  if (draft.environment === "community") {
    if (!spec) return { ok: false, issue: { field: "driverPackage", message: "packageRequired" } };
    if (!driver || driver.spec !== spec || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(driver.id)) {
      return { ok: false, issue: { field: "driverPackage", message: "verifyFirst" } };
    }
  }
  const capabilities = workspaceDriverCapabilities(draft.environment, driver);
  if (capabilities.missingPort) return { ok: false, issue: { field: "driverPackage", message: "unsupportedBridge" } };
  return { ok: true, input: {
    name: location.name,
    driver: draft.environment === "desktop" ? "cua" : driver!.id,
    ...(location.custom ? { workspace: location.path! } : {}),
    ...(draft.environment === "community" ? { driverPackage: spec } : {}),
    ...(capabilities.supportsGame && draft.game.trim() ? { game: draft.game.trim() } : {}),
    ...(capabilities.stdio && draft.cuaCommand.trim() ? { cuaCommand: draft.cuaCommand.trim() } : {}),
  } };
}
