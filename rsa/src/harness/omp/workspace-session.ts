import { createReadStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { readWorkspaceIdentity, registerWorkspace } from "../../../../shared/ludens.ts";
import { initializeWorkspaceState, writeCurrentSession, type WorkspaceState } from "../workspace-state.ts";

const ownershipType = "ludens.workspace";
const missing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; };
function within(root: string, file: string) {
  const path = relative(root, file);
  return path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`) ? path : undefined;
}

async function sessionOwnership(sessionFile: string) {
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: { type: string; cwd: string; id: string } | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (!header) {
        if (record?.type === "title") continue;
        if (record?.type !== "session" || typeof record.cwd !== "string" || typeof record.id !== "string") {
          throw new Error("The resumed session has no workspace header");
        }
        header = record;
      } else if (record.type === "custom" && record.customType === ownershipType) {
        const owner = record.data;
        if (owner?.version !== 1 || typeof owner.workspaceId !== "string" || !owner.workspaceId) {
          throw new Error("Invalid session workspace ownership");
        }
        // The first persisted marker fixes ownership. Leave body/tail repair
        // to OMP; a crash during a later append must not prevent recovery.
        return { header, workspaceId: owner.workspaceId as string };
      }
    }
    if (!header) throw new Error("The resumed session has no workspace header");
    return { header, workspaceId: undefined };
  } finally { lines.close(); input.destroy(); }
}

/** Check stable ownership before OMP opens (and may repair) an existing transcript. */
export async function validateSessionWorkspace(sessionFile: string, workspace: string) {
  const [file, current] = await Promise.all([realpath(sessionFile), realpath(workspace)]);
  const identity = await readWorkspaceIdentity(current);
  const ownership = await sessionOwnership(file);
  if (!ownership.workspaceId) throw new Error("Legacy session requires explicit workspace import before resuming");
  if (!identity || ownership.workspaceId !== identity.id) throw new Error("The resumed session belongs to a different workspace");
  if (!within(join(current, ".rsa", "shiori", "sessions"), file)) {
    throw new Error("Session is outside this workspace; explicitly import it before resuming");
  }
}

export async function openWorkspaceSession(state: WorkspaceState, resume?: string) {
  if (resume) await validateSessionWorkspace(resume, state.workspace);
  await registerWorkspace(state.workspace, state.globalHome);
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const manager = resume
    ? await SessionManager.open(await realpath(resume), state.sessionsDir, undefined, { throwIfMissing: true })
    : SessionManager.create(state.workspace, state.sessionsDir);
  try {
    // Retain historical cwd in the transcript, but run all tools in its current workspace.
    manager.setCwdWithoutRelocation(state.workspace);
    if (!resume) {
      manager.appendCustomEntry(ownershipType, { version: 1, workspaceId: state.id });
      await manager.setSessionName("RSA exploration", "user");
    }
    return manager;
  } catch (error) { await manager.close(); throw error; }
}

/** OMP otherwise defers creating a file until the first assistant response. */
export async function selectWorkspaceSession(state: WorkspaceState, manager: SessionManager) {
  await manager.ensureOnDisk();
  await manager.flush();
  const file = manager.getSessionFile();
  if (!file || !manager.isSessionOnDisk()) throw new Error("The session was not persisted");
  await validateSessionWorkspace(file, state.workspace);
  await writeCurrentSession(state, file);
  return file;
}

/** Explicit, copy-only import. The CLI must first ensure neither workspace has a live host. */
export async function importLegacyWorkspaceState(workspace: string, options: {
  legacyStateDir?: string; previousWorkspace?: string; globalHome?: string;
} = {}) {
  const state = await initializeWorkspaceState(workspace, options.globalHome, { importLegacy: true });
  const previous = resolve(options.previousWorkspace ?? state.workspace);
  const canonicalPrevious = await realpath(previous).catch(missing) ?? previous;
  const source = options.legacyStateDir ? await realpath(options.legacyStateDir) : state.dir;
  const receipt = join(state.dir, "legacy-import.json");
  const prior = JSON.parse(await readFile(receipt, "utf8").catch(missing) ?? "null");
  if (prior) {
    if (prior.workspaceId !== state.id || prior.source !== source || prior.previousWorkspace !== canonicalPrevious) {
      throw new Error("This workspace already imported a different legacy state");
    }
    return prior;
  }
  if (options.legacyStateDir) {
    const recorded = JSON.parse(await readFile(join(source, "workspace.json"), "utf8"));
    if (typeof recorded.workspace !== "string" || (await realpath(recorded.workspace).catch(missing) ?? resolve(recorded.workspace)) !== canonicalPrevious) {
      throw new Error("Legacy state belongs to a different workspace");
    }
  }
  let oldSessions = options.legacyStateDir && await lstat(join(source, "sessions")).catch(missing)
    ? join(source, "sessions") : options.legacyStateDir && await lstat(join(source, "shiori", "sessions")).catch(missing)
      ? join(source, "shiori", "sessions") : state.sessionsDir;
  if ((await lstat(oldSessions).catch(missing))?.isSymbolicLink()) {
    const target = resolve(oldSessions, "..", await readlink(oldSessions));
    const canonical = await realpath(oldSessions).catch(missing);
    if (canonical !== state.sessionsDir && target !== join(previous, ".rsa", "shiori", "sessions")) {
      throw new Error("Legacy session alias points outside the imported workspace");
    }
    oldSessions = state.sessionsDir;
  }
  const copies: { source: string; target: string }[] = [];
  const sessions: { source: string; target: string }[] = [];
  async function inspectTree(from: string, to: string, transcripts: boolean) {
    const info = await lstat(from).catch(missing);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Legacy import requires a real directory: ${from}`);
    const destination = await lstat(to).catch(missing);
    if (destination && (!destination.isDirectory() || destination.isSymbolicLink())) {
      throw new Error(`Conflicting legacy destination directory: ${to}`);
    }
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const path = join(from, entry.name), target = join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Legacy import cannot copy symbolic links: ${path}`);
      if (entry.isDirectory()) { await inspectTree(path, target, false); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported legacy state entry: ${path}`);
      const isSession = transcripts && entry.name.endsWith(".jsonl");
      if (isSession) {
        const owner = await sessionOwnership(path);
        if (owner.workspaceId ? owner.workspaceId !== state.id
          : (await realpath(owner.header.cwd).catch(missing) ?? resolve(owner.header.cwd)) !== canonicalPrevious) {
          throw new Error(`Legacy session belongs to a different workspace: ${path}`);
        }
        sessions.push({ source: path, target });
      }
      if (path === target) continue;
      const existing = await lstat(target).catch(missing);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Conflicting legacy destination: ${target}`);
        const [original, current] = await Promise.all([readFile(path), readFile(target)]);
        if (!original.equals(current)) {
          // An interrupted import may already have appended ownership evidence.
          const imported = isSession && current.subarray(0, original.length).equals(original)
            && (await sessionOwnership(target)).workspaceId === state.id;
          if (!imported) throw new Error(`Conflicting legacy destination: ${target}`);
        }
      } else copies.push({ source: path, target });
    }
  }
  await inspectTree(oldSessions, state.sessionsDir, true);
  if (source !== state.dir) await inspectTree(join(source, "skill-versions"), state.versionsDir, false);
  const indexPaths = [join(source, "current-session.json"), join(source, "shiori", "current-session.json")];
  let selected: string | undefined;
  for (const path of indexPaths) {
    const index = JSON.parse(await readFile(path, "utf8").catch(missing) ?? "null");
    if (!index) continue;
    if (typeof index.sessionFile !== "string") throw new Error("Invalid legacy session selection");
    const recorded = resolve(index.version === 1 ? previous : resolve(path, ".."), index.sessionFile);
    const absolute = await realpath(recorded).catch(missing) ?? recorded;
    const suffix = within(oldSessions, absolute) ?? within(join(previous, ".rsa", "shiori", "sessions"), absolute);
    if (!suffix) throw new Error("Legacy selection points outside the imported sessions");
    selected = join(state.sessionsDir, suffix);
    if (!sessions.some(session => session.target === selected)) throw new Error("Legacy selection points to a missing session; recover it explicitly before importing");
    break;
  }
  // Detect an active clone's registry ownership before changing any history.
  await registerWorkspace(state.workspace, state.globalHome);
  for (const file of copies) {
    await mkdir(resolve(file.target, ".."), { recursive: true });
    await copyFile(file.source, file.target, constants.COPYFILE_EXCL);
  }
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  for (const file of sessions) {
    if ((await sessionOwnership(file.target)).workspaceId) continue;
    const manager = await SessionManager.open(file.target, state.sessionsDir, undefined, { throwIfMissing: true });
    try {
      manager.setCwdWithoutRelocation(state.workspace);
      manager.appendCustomEntry(ownershipType, { version: 1, workspaceId: state.id,
        importedFrom: { cwd: canonicalPrevious, session: file.source } });
      await manager.ensureOnDisk(); await manager.flush();
    } finally { await manager.close(); }
  }
  if (selected) await writeCurrentSession(state, selected);
  const result = { version: 1, workspaceId: state.id, source, previousWorkspace: canonicalPrevious,
    sessions: sessions.length, copiedFiles: copies.length, importedAt: new Date().toISOString(),
    limitations: ["Only sessions and skill snapshots are imported; old run provenance, event-source paths and recording references are not rewritten, and external media are not copied. Old recordings may be unavailable after moving the workspace.",
      "Legacy benchmark records are not rewritten; path-owned trials still require their original workspace path."] };
  await writeFile(receipt, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
