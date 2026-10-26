import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface WorkspaceState {
  workspace: string;
  id: string;
  dir: string;
  shioriDir: string;
  sessionsDir: string;
  versionsDir: string;
  socket: string;
}

export async function resolveWorkspaceState(workspacePath: string, artifactRoot: string): Promise<WorkspaceState> {
  await mkdir(workspacePath, { recursive: true });
  const workspace = await realpath(workspacePath);
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const name = basename(workspace).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "workspace";
  const id = `ws-${name}-${hash}`;
  const dir = resolve(artifactRoot, id);
  const shioriDir = join(workspace, ".rsa", "shiori");
  const sessionsDir = join(shioriDir, "sessions");
  await Promise.all([mkdir(dir, { recursive: true }), mkdir(sessionsDir, { recursive: true })]);
  return { workspace, id, dir, shioriDir, sessionsDir, versionsDir: join(dir, "skill-versions"),
    socket: `/tmp/playness-rsa-${process.getuid!()}-${hash}.sock` };
}

export async function readCurrentSession(state: WorkspaceState): Promise<string | undefined> {
  try {
    const { sessionFile } = JSON.parse(await readFile(join(state.shioriDir, "current-session.json"), "utf8"));
    return sessionFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeCurrentSession(state: WorkspaceState, sessionFile: string): Promise<void> {
  const path = join(state.shioriDir, "current-session.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ sessionFile: resolve(sessionFile) }, null, 2)}\n`);
  await rename(temporary, path);
}
