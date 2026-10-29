import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorkspaceIdentity } from "../../shared/ludens.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-import-command-")));
  const home = join(root, "global"), workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "rsa.json"), '{"driver":"cua"}');
  const run = async (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
    delete env.RSA_WORKSPACE; delete env.RSA_SOCKET; delete env.BASEWARE_SOCKET;
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), "workspace", ...args], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr };
  };
  return { root, workspace, run, close: () => rm(root, { recursive: true, force: true }) };
}

async function listening(workspace: string, service: "rsa" | "baseware") {
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const path = `/tmp/ludens-${service}-${process.getuid!()}-${hash}.sock`;
  const server = createServer(socket => socket.end());
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  return () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

test("import and new-id refuse an active workspace without changing its identity or files", async () => {
  const f = await fixture();
  try {
    await ensureWorkspaceIdentity(f.workspace);
    const identityPath = join(f.workspace, ".rsa/workspace.json");
    const before = await readFile(identityPath, "utf8");
    for (const service of ["rsa", "baseware"] as const) {
      const stop = await listening(f.workspace, service);
      try {
        for (const args of [["import", f.workspace], ["open", f.workspace, "--new-id"]]) {
          const result = await f.run(...args);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(`Workspace is running (${service})`);
          expect(await readFile(identityPath, "utf8")).toBe(before);
          expect(await readdir(join(f.workspace, ".rsa"))).toEqual(["workspace.json"]);
        }
      } finally { await stop(); }
    }
  } finally { await f.close(); }
});

test("an active previous workspace is detected through a symlink before importing a moved copy", async () => {
  const f = await fixture();
  try {
    const previous = join(f.root, "previous"), alias = join(f.root, "previous-alias");
    await mkdir(previous);
    await symlink(previous, alias);
    const stop = await listening(previous, "rsa");
    try {
      const result = await f.run("import", f.workspace, "--previous-workspace", alias);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Workspace is running (rsa)");
      expect(await readdir(f.workspace)).toEqual(["rsa.json"]);
    } finally { await stop(); }
  } finally { await f.close(); }
});
