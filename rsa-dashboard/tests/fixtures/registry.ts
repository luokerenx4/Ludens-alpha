import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWorkspace } from "../../../shared/ludens";

/** Register only disposable fixture directories; never use the caller's global home. */
export async function registerFixture(home: string, id: string, workspace: string) {
  await mkdir(join(workspace, ".rsa"), { recursive: true });
  await writeFile(join(workspace, ".rsa", "workspace.json"), JSON.stringify({ version: 1, id }));
  return registerWorkspace(workspace, home);
}
