import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { getDriver, type DriverRegistration } from "./registry.ts";
import { asRegistration, driverCacheDir, parseDriverSpec, type DriverSpec } from "./spec.ts";

type PackageJson = { name?: string; exports?: unknown };

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed: ${stderr.trim()}`);
}

async function packageJson(directory: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

function npmName(spec: string): string {
  const version = spec.indexOf("@", 1);
  return version < 0 ? spec : spec.slice(0, version);
}

/** A completed cache is published only after checkout and dependency installation succeed. */
async function externalPackage(id: string, spec: Exclude<DriverSpec, { kind: "file" }>, cacheRoot: string): Promise<{ directory: string; entry: string }> {
  const identity = spec.kind === "github" ? `github:${spec.org.toLowerCase()}/${spec.repo.toLowerCase()}#${spec.rev}` : `npm:${spec.package}`;
  const key = createHash("sha256").update(identity).digest("hex");
  const cacheDir = join(driverCacheDir(cacheRoot, id), key);
  const root = dirname(cacheDir);
  await mkdir(root, { recursive: true });
  if (!existsSync(join(cacheDir, ".complete"))) {
    const staging = await mkdtemp(join(root, ".install-"));
    try {
      await writeFile(join(staging, "package.json"), JSON.stringify({ private: true }));
      if (spec.kind === "github") {
        const checkout = join(staging, "package");
        await mkdir(checkout);
        await run(["git", "init"], checkout);
        await run(["git", "remote", "add", "origin", spec.url], checkout);
        await run(["git", "fetch", "--depth", "1", "origin", spec.rev], checkout);
        await run(["git", "checkout", "--detach", "FETCH_HEAD"], checkout);
        await run([process.execPath, "install"], checkout);
        const manifest = await packageJson(checkout);
        if (!manifest.name || !/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(manifest.name)) throw new Error("Github driver package.json must declare a valid package name");
        const link = join(staging, "node_modules", manifest.name);
        await mkdir(dirname(link), { recursive: true });
        await symlink(manifest.name.startsWith("@") ? "../../package" : "../package", link);
      } else {
        await run([process.execPath, "add", spec.package], staging);
      }
      await writeFile(join(staging, ".complete"), identity);
      try {
        await rename(staging, cacheDir);
      } catch (error) {
        if (!existsSync(join(cacheDir, ".complete"))) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const directory = spec.kind === "github" ? join(cacheDir, "package") : join(cacheDir, "node_modules", npmName(spec.package));
  const name = spec.kind === "github" ? (await packageJson(directory)).name! : npmName(spec.package);
  return { directory, entry: Bun.resolveSync(name, cacheDir) };
}

async function resolvePackage(id: string, packageSpec: string, cacheRoot: string): Promise<{ directory: string; entry: string }> {
  const spec = parseDriverSpec(packageSpec);
  if (spec.kind !== "file") return externalPackage(id, spec, cacheRoot);
  const path = await realpath(spec.path).catch(() => { throw new Error(`Driver path not found: ${spec.path}`); });
  if (!(await stat(path)).isDirectory()) return { directory: dirname(path), entry: path };
  // Resolve directory packages through Bun's package resolver, including exports conditions.
  const manifest = await packageJson(path);
  const entry = manifest.name && manifest.exports !== undefined ? Bun.resolveSync(manifest.name, path) : Bun.resolveSync(path, dirname(path));
  return { directory: path, entry };
}

/** Resolve packages outside the workspace and import only the selected driver's entrypoint. */
export async function resolveDriver(id: string, packageSpec: string | undefined, cacheRoot: string): Promise<DriverRegistration> {
  if (!packageSpec) return getDriver(id);
  const { entry } = await resolvePackage(id, packageSpec, cacheRoot);
  return asRegistration(await import(entry), id);
}

export function defaultDriverCacheRoot(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "ludens/baseware/drivers");
}
