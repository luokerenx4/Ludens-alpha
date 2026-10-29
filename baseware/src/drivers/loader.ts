import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { getDriver, type DriverRegistration, type DriverSource } from "./registry.ts";
import { asRegistration, driverCacheDir, parseDriverSpec, type DriverSpec } from "./spec.ts";

type PackageJson = { name?: string; version?: string; exports?: unknown };
type ResolvedPackage = { entry: string; source: Exclude<DriverSource, { kind: "builtin" }> };

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function packageJson(directory: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

function npmName(spec: string): string {
  const version = spec.indexOf("@", 1);
  return version < 0 ? spec : spec.slice(0, version);
}

/** A completed cache is published only after checkout and dependency installation succeed. */
async function externalPackage(id: string, spec: Exclude<DriverSpec, { kind: "file" }>, cacheRoot: string): Promise<ResolvedPackage> {
  const transport = spec.kind === "github" && spec.url.startsWith("git@") ? "ssh" : "https";
  // A completed HTTPS install must not bypass an explicitly selected SSH fetch.
  // This also separates new GitHub caches from pre-provenance cache markers.
  const identity = spec.kind === "github" ? `github:${transport}:${spec.org.toLowerCase()}/${spec.repo.toLowerCase()}#${spec.rev}` : `npm:${spec.package}`;
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
  const manifest = await packageJson(directory);
  const name = spec.kind === "github" ? manifest.name! : npmName(spec.package);
  const entry = Bun.resolveSync(name, cacheDir);
  if (spec.kind === "github") {
    // Read the installed checkout, including a cached tag that has moved remotely.
    // Refuse missing/corrupt Git metadata rather than claiming the requested ref
    // or accidentally reporting a containing repository's HEAD.
    const top = await run(["git", "rev-parse", "--show-toplevel"], directory);
    if (await realpath(top) !== await realpath(directory)) throw new Error("Driver cache is not an independent Git checkout");
    const resolvedCommit = await run(["git", "rev-parse", "--verify", "HEAD^{commit}"], directory);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(resolvedCommit)) throw new Error("Driver cache has an invalid resolved Git commit");
    const repository = transport === "ssh" ? `git@github.com:${spec.org}/${spec.repo}.git` : `https://github.com/${spec.org}/${spec.repo}.git`;
    return { entry, source: { kind: "github", spec: `${repository}#${spec.rev}`, repository,
      transport, requestedRevision: spec.rev, resolvedCommit } };
  }
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("Installed npm driver package must declare its resolved version");
  return { entry, source: { kind: "npm", spec: `npm:${spec.package}`, packageName: name, resolvedVersion: manifest.version } };
}

async function resolvePackage(id: string, packageSpec: string, cacheRoot: string): Promise<ResolvedPackage> {
  const spec = parseDriverSpec(packageSpec);
  if (spec.kind !== "file") return externalPackage(id, spec, cacheRoot);
  const path = await realpath(spec.path).catch(() => { throw new Error(`Driver path not found: ${spec.path}`); });
  const directory = (await stat(path)).isDirectory();
  // Resolve directory packages through Bun's package resolver, including exports conditions.
  const manifest = directory ? await packageJson(path) : undefined;
  const entry = directory ? await realpath(manifest?.name && manifest.exports !== undefined
    ? Bun.resolveSync(manifest.name, path) : Bun.resolveSync(path, dirname(path))) : path;
  return { entry, source: { kind: "file", spec: `file:${path}`, entry: directory ? relative(path, entry) : relative(dirname(path), entry),
    entrySha256: createHash("sha256").update(await readFile(entry)).digest("hex") } };
}

// Bun caches imported modules by entrypoint. Keep the original file digest with
// that import if a caller edits the file and resolves it again in one process.
const importedEntries = new Map<string, Promise<{ module: unknown; source: ResolvedPackage["source"] }>>();
async function registrationFrom(resolved: ResolvedPackage, expectedId?: string): Promise<DriverRegistration> {
  let imported = importedEntries.get(resolved.entry);
  if (!imported) {
    imported = import(resolved.entry).then(module => ({ module, source: resolved.source }));
    importedEntries.set(resolved.entry, imported);
  }
  const loaded = await imported;
  const registration = asRegistration(loaded.module, expectedId);
  const { id, version, fallbackVersion, transport, defaultPort, needsGame, launchHint, launchCommand, launchEnv } = registration;
  // Do not mutate frozen package exports or lose prototype methods/getters.
  return { id, version, fallbackVersion, transport, defaultPort, needsGame, launchHint, launchCommand, launchEnv,
    load: options => registration.load(options), source: loaded.source };
}

/** Validate a community driver package without knowing its id. Never calls load(). */
export async function discoverDriver(packageSpec: string, cacheRoot: string): Promise<DriverRegistration> {
  return registrationFrom(await resolvePackage("discover", packageSpec, cacheRoot));
}

/** Resolve packages outside the workspace and import only the selected driver's entrypoint. */
export async function resolveDriver(id: string, packageSpec: string | undefined, cacheRoot: string): Promise<DriverRegistration> {
  if (!packageSpec) return { ...getDriver(id), source: { kind: "builtin" } };
  return registrationFrom(await resolvePackage(id, packageSpec, cacheRoot), id);
}
export function defaultDriverCacheRoot(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "ludens/baseware/drivers");
}
