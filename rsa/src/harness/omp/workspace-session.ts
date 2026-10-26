import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { readCurrentSession, writeCurrentSession, type WorkspaceState } from "../workspace-state.ts";

/** One-time relocation, called only after the host owns the workspace socket. */
export async function migrateWorkspaceSessions(state: WorkspaceState) {
  const legacyDir = join(state.dir, "sessions");
  const legacyIndex = join(state.dir, "current-session.json");
  const moving = join(state.dir, ".sessions-migrating");
  const missing = (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  };
  const index = await readFile(legacyIndex, "utf8").catch(missing);
  const selected = index ? resolve(state.dir, JSON.parse(index).sessionFile) : undefined;
  const legacy = await lstat(legacyDir).catch(missing);
  if (legacy?.isSymbolicLink()) {
    if (await realpath(legacyDir) !== state.sessionsDir) throw new Error(`Unexpected session directory alias: ${legacyDir}`);
  } else if (legacy) {
    // Never merge two histories or overwrite a new session. resolveWorkspaceState
    // may have created an empty destination; rmdir refuses non-empty directories.
    await rmdir(state.sessionsDir).catch(error => {
      if (error.code !== "ENOENT") throw new Error(`Cannot migrate sessions into non-empty ${state.sessionsDir}`, { cause: error });
    });
    await writeFile(moving, "");
    await rename(legacyDir, state.sessionsDir);
  }
  if (await lstat(moving).catch(missing)) {
    // Old transcripts/logs contain absolute artifact paths. Keep one storage copy.
    // The marker also recovers an interrupted move with no selected transcript.
    if (!await lstat(legacyDir).catch(missing)) await symlink(state.sessionsDir, legacyDir, "dir");
    await unlink(moving);
  }
  if (selected && !await readCurrentSession(state)) {
    const path = relative(legacyDir, selected);
    const file = path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
      ? join(state.sessionsDir, path) : selected;
    // Validate the session actually chosen by the caller, after migration. A stale
    // default must not block --new-session or an explicit --resume recovery.
    await writeCurrentSession(state, await realpath(file).catch(missing) ?? file);
  }
  if (index !== undefined) await unlink(legacyIndex);
}

/** Check ownership before OMP opens (and may repair) an existing transcript. */
export async function validateSessionWorkspace(sessionFile: string, workspace: string) {
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    // OMP may reserve a title record before its session header.
    let header;
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (record?.type === "title") continue;
      header = record;
      break;
    }
    if (header?.type !== "session" || typeof header.cwd !== "string") {
      throw new Error("The resumed session has no workspace header");
    }
    const [recorded, current] = await Promise.all([realpath(header.cwd), realpath(workspace)]);
    if (recorded !== current) throw new Error("The resumed session belongs to a different workspace");
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function openWorkspaceSession(state: WorkspaceState, resume?: string) {
  if (resume) await validateSessionWorkspace(resume, state.workspace);
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const manager = resume
    ? await SessionManager.open(await realpath(resume), state.sessionsDir, undefined, { throwIfMissing: true })
    : SessionManager.create(state.workspace, state.sessionsDir);
  try {
    if (!resume) await manager.setSessionName("RSA exploration", "user");
    return manager;
  } catch (error) {
    await manager.close();
    throw error;
  }
}

/** OMP otherwise defers creating a file until the first assistant response. */
export async function selectWorkspaceSession(state: WorkspaceState, manager: SessionManager) {
  await manager.ensureOnDisk();
  await manager.flush();
  const file = manager.getSessionFile();
  if (!file || !manager.isSessionOnDisk()) throw new Error("The session was not persisted");
  await writeCurrentSession(state, file);
  return file;
}
