import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureWorkspaceIdentity, ludensHome, readWorkspaceIdentity } from "../../../shared/ludens.ts";

export interface WorkspaceState {
  workspace: string;
  globalHome: string;
  id: string;
  dir: string;
  shioriDir: string;
  sessionsDir: string;
  versionsDir: string;
  socket: string;
}

/** Address discovery is read-only, including for directories that were never initialized. */
export async function resolveWorkspaceAddress(workspacePath: string) {
  const workspace = await realpath(workspacePath);
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return { workspace, socket: `/tmp/ludens-rsa-${process.getuid!()}-${hash}.sock` };
}

const initializationRequired = () => new Error("Workspace has no Ludens identity. Use rsa init for a new workspace, or rsa workspace import <directory> for existing history.");

/** Resolve an existing workspace without creating directories, identity, or registration. */
export async function resolveWorkspaceState(workspacePath: string, globalHome = ludensHome()): Promise<WorkspaceState> {
  const address = await resolveWorkspaceAddress(workspacePath).catch(error => { if (error.code === "ENOENT") throw initializationRequired(); throw error; });
  const { workspace, socket } = address;
  const { id } = await readWorkspaceIdentity(workspace).catch(error => { if (error.code === "ENOENT") throw initializationRequired(); throw error; });
  const dir = join(workspace, ".rsa");
  const shioriDir = join(workspace, ".rsa", "shiori");
  const sessionsDir = join(shioriDir, "sessions");
  return { workspace, globalHome: resolve(globalHome), id, dir, shioriDir, sessionsDir, versionsDir: join(dir, "skill-versions"), socket };
}

/** Explicit creation for a new execution workspace; adopting old state belongs to import. */
export async function initializeWorkspaceState(workspacePath: string, globalHome = ludensHome(), options: { importLegacy?: boolean } = {}): Promise<WorkspaceState> {
  await mkdir(workspacePath, { recursive: true });
  const workspace = await realpath(workspacePath);
  const identity = await readWorkspaceIdentity(workspace).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!identity && !options.importLegacy) {
    const state = await lstat(join(workspace, ".rsa")).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
    const logs = await readdir(join(workspace, "logs")).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    if (state || logs.length) throw initializationRequired();
  }
  await ensureWorkspaceIdentity(workspace);
  const state = await resolveWorkspaceState(workspace, globalHome);
  await mkdir(state.sessionsDir, { recursive: true });
  return state;
}

export async function readCurrentSession(state: WorkspaceState): Promise<string | undefined> {
  try {
    const selected = JSON.parse(await readFile(join(state.shioriDir, "current-session.json"), "utf8"));
    if (selected.version !== 1 || selected.workspaceId !== state.id || typeof selected.sessionFile !== "string" || isAbsolute(selected.sessionFile)) {
      throw new Error("Legacy or foreign session selection; explicitly import this workspace or start a new session");
    }
    const file = resolve(state.workspace, selected.sessionFile);
    sessionRelativePath(state, file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeCurrentSession(state: WorkspaceState, sessionFile: string): Promise<void> {
  const path = join(state.shioriDir, "current-session.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, workspaceId: state.id, sessionFile: sessionRelativePath(state, sessionFile) }, null, 2)}\n`);
  await rename(temporary, path);
}

function sessionRelativePath(state: WorkspaceState, sessionFile: string) {
  const within = relative(state.sessionsDir, resolve(sessionFile));
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new Error("Session must be stored inside this workspace's session directory; explicitly import external sessions");
  }
  return relative(state.workspace, resolve(sessionFile));
}
