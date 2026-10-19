import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(import.meta.dir, "../../..");
const sha = (bytes: Uint8Array) => new Bun.SHA256().update(bytes).digest("hex");

/** Record the inputs needed to compare runs, without copying repository or workspace contents. */
export async function runProvenance(workspace: string) {
  const git = async (args: string[]) => (await exec("git", args, { cwd: repository })).stdout.trim();
  const code = await Promise.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain"])])
    .then(([commit, status]) => ({ commit, dirty: status.length > 0 })).catch(() => null);
  const prompts = Object.fromEntries(await Promise.all(["explore", "continue", "consolidate"].map(async name =>
    [name, sha(await readFile(join(repository, "rsa/prompts", `${name}.md`)))])));
  return { code, prompts, workspaceInstructionsSHA256: sha(await readFile(join(workspace, "AGENTS.md"))) };
}
