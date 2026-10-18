import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { writeCurrentSession, type WorkspaceState } from "../workspace-state.ts";

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
    ? await SessionManager.open(resume, state.sessionsDir, undefined, { throwIfMissing: true })
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
