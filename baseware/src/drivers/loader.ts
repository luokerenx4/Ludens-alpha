import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDriver, registerDriver, type DriverRegistration } from "./registry.ts";
import { asRegistration, driverCacheDir, parseDriverSpec } from "./spec.ts";
async function importPackage(spec: string): Promise<unknown> {
  try {
    return await import(spec);
  } catch (error) {
    throw new Error(`Cannot load driver package ${JSON.stringify(spec)} — is it installed? Run: bun add ${spec}`);
  }
}

async function ensureGithubCheckout(cacheDir: string, url: string, rev: string, id: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const proc = Bun.spawn(["git", "init"], { cwd: cacheDir, stdout: "ignore", stderr: "pipe" });
  await proc.exited;
  const run = async (args: string[], allowFail = false) => {
    const child = Bun.spawn(["git", ...args], { cwd: cacheDir, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0 && !allowFail) throw new Error(`git ${args[0]} failed for driver ${JSON.stringify(id)}: ${stderr.trim()}`);
    return new Response(child.stdout).text();
  };
  const remote = (await run(["remote"], true)).trim();
  if (!remote) await run(["remote", "add", "origin", url]);
  else await run(["remote", "set-url", "origin", url]);
  await run(["fetch", "--depth", "1", "origin", rev]);
  await run(["checkout", "--detach", "FETCH_HEAD"]);
  const actual = (await run(["rev-parse", "HEAD"])).trim();
  if (!actual.startsWith(rev) && actual !== rev) {
    // Tags/branches resolve via FETCH_HEAD; only enforce exactness for full SHAs.
    if (/^[0-9a-f]{40}$/i.test(rev)) throw new Error(`Driver ${JSON.stringify(id)} revision mismatch: expected ${rev}, got ${actual}`);
  }
  return cacheDir;
}

/**
 * Resolve --driver to a registration. Built-ins stay as-is; with --driver-package the
 * spec (npm / github repo link / file:) is loaded, cached outside the repo and validated.
 */
export async function resolveDriver(id: string, packageSpec: string | undefined, cacheRoot: string): Promise<DriverRegistration> {
  if (!packageSpec) return getDriver(id);
  const spec = parseDriverSpec(packageSpec);
  if (spec.kind === "npm") {
    const registration = asRegistration(await importPackage(spec.package), id);
    registerDriverIfMissing(registration);
    return registration;
  }
  if (spec.kind === "file") {
    const entry = await realpath(spec.path).catch(() => { throw new Error(`Driver path not found: ${spec.path}`); });
    const registration = asRegistration(await import(entry), id);
    registerDriverIfMissing(registration);
    return registration;
  }
  const cacheDir = driverCacheDir(cacheRoot, id);
  const checkout = existsSync(join(cacheDir, ".git"))
    ? cacheDir : await ensureGithubCheckout(cacheDir, spec.url, spec.rev, id);
  try {
    const entry = (await import(join(checkout, "package.json"))) as { default?: { main?: string; exports?: unknown } };
    const main = entry?.default?.main ?? "index.js";
    const registration = asRegistration(await import(join(checkout, main)), id);
    registerDriverIfMissing(registration);
    return registration;
  } catch (error) {
    throw new Error(`Cannot load github driver ${JSON.stringify(id)} from ${cacheDir}: ${(error as Error).message}. Delete the cache dir to refetch.`);
  }
}

function registerDriverIfMissing(registration: DriverRegistration): void {
  try {
    registerDriver(registration);
  } catch (error) {
    if (!String(error).includes("Duplicate driver")) throw error;
  }
}

export function defaultDriverCacheRoot(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "playness/baseware/drivers");
}
