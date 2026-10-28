import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parse } from "smol-toml";
import { isObject, validateIdentity, type TaskConfig, type TaskDefinition } from "./contract.ts";

export const HARBOR_CONTRACT_REVISION = "f3a5a923f6d722472c9e797af836ae4425fb215f";
const defaults = ["__pycache__/", "*.pyc", ".DS_Store", "*.swp", "*.swo", "*~"];
const exists = async (path: string) => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const posix = (path: string) => path.split(sep).join("/");
export async function hashFile(path: string, byteLength?: number): Promise<string> {
  if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) throw new Error("Invalid evidence prefix length");
  const hash = createHash("sha256");
  if (byteLength === 0) return hash.digest("hex");
  let read = 0;
  for await (const chunk of createReadStream(path, byteLength === undefined ? {} : { end: byteLength - 1 })) { hash.update(chunk); read += chunk.length; }
  if (byteLength !== undefined && read !== byteLength) throw new Error("Evidence prefix is incomplete");
  return hash.digest("hex");
}
/** Reject traversal and links escaping the trusted root, including a symlinked leaf. */
export async function containedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("Evidence path must be relative to its trusted root");
  const base = await realpath(root), target = await realpath(resolve(base, path));
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Evidence path escapes its trusted root");
  return target;
}
/** Harbor publisher file selection and ordered content hash; no author code is imported. */
export async function taskDigest(taskDir: string): Promise<{ digest: string; files: string[] }> {
  const root = await realpath(taskDir), rules = new Map<string, Ignore>();
  const scope = (rel: string) => /^(tests|solution)(\/|$)|^steps\/[^/]+\/(tests|solution)(\/|$)/.test(rel);
  async function rulesAt(dir: string) {
    if (!scope(posix(relative(root, dir)))) return undefined;
    let cached = rules.get(dir);
    if (!cached) {
      const file = join(dir, ".harborignore");
      cached = ignore({ ignorecase: false });
      if (await exists(file)) { await containedPath(root, relative(root, file)); cached.add(await readFile(file, "utf8")); }
      rules.set(dir, cached);
    }
    return cached;
  }
  async function matches(path: string, directory: boolean): Promise<boolean> {
    const rel = posix(relative(root, path));
    if (basename(path) === ".harborignore") return true;
    if (!scope(rel)) return false;
    const specs: { dir: string; rule: Ignore }[] = [];
    let candidate = root;
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const rule = await rulesAt(candidate); if (rule) specs.push({ dir: candidate, rule });
      candidate = join(candidate, parts[i]!);
      const suffix = i < parts.length - 1 || directory ? "/" : "";
      if (!scope(posix(relative(root, candidate)))) continue;
      let excluded = false;
      for (const spec of specs) {
        const result = spec.rule.test(posix(relative(spec.dir, candidate)) + suffix);
        if (result.ignored) excluded = true; else if (result.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  }
  async function excluded(path: string, directory: boolean) {
    if (await matches(path, directory)) return true;
    const target = await containedPath(root, relative(root, path));
    return target !== path && await matches(target, directory);
  }
  const files: string[] = [];
  for (const name of ["task.toml", "instruction.md", "README.md", "trajectory.json"]) {
    if (await exists(join(root, name))) { await containedPath(root, name); files.push(name); }
  }
  async function visit(directory: string) {
    if (await excluded(directory, true)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = await stat(path);
      if (await excluded(path, info.isDirectory())) continue;
      if (info.isFile()) files.push(posix(relative(root, path)));
      // Harbor select_files does not traverse descendant symlink directories.
      else if (info.isDirectory() && !entry.isSymbolicLink()) await visit(path);
    }
  }
  for (const name of ["environment", "tests", "solution", "steps"]) if (await exists(join(root, name))) await visit(join(root, name));
  const patterns = await exists(join(root, ".gitignore")) ? (await readFile(await containedPath(root, ".gitignore"), "utf8")).split(/\r?\n/) : defaults;
  // Publisher uses PathSpec, not GitIgnoreSpec: later root negations can reinclude a child.
  const gitRules = patterns.filter(pattern => pattern && !pattern.startsWith("#")).map(pattern => ignore({ ignorecase: false }).add(pattern));
  const selected = files.filter(path => {
    let excluded = false;
    for (const rule of gitRules) { const match = rule.test(path); if (match.ignored) excluded = true; else if (match.unignored) excluded = false; }
    return !excluded;
  }).sort();
  const outer = createHash("sha256");
  for (const path of selected) outer.update(`${path}\0${await hashFile(join(root, path))}\n`);
  return { digest: `sha256:${outer.digest("hex")}`, files: selected };
}

/** Native is a deliberately smaller consumer profile, not silent emulation of Harbor isolation. */
export function nativeRequirements(config: TaskConfig): string[] {
  const unsupported: string[] = [];
  const allowedRoot = new Set(["schema_version", "task", "metadata", "agent", "verifier", "environment", "solution", "source", "steps", "multi_step_reward_strategy", "artifacts"]);
  for (const key of Object.keys(config)) if (!allowedRoot.has(key)) unsupported.push(key);
  if (config.steps !== undefined) unsupported.push("steps");
  if (config.multi_step_reward_strategy !== undefined) unsupported.push("multi_step_reward_strategy");
  if (Array.isArray(config.artifacts) && config.artifacts.length) unsupported.push("artifacts (container collection)");
  const supported: Record<string, Set<string>> = {
    environment: new Set(["env", "os", "network_mode"]),
    verifier: new Set(["env", "timeout_sec", "network_mode", "environment_mode"]),
    agent: new Set(["timeout_sec", "network_mode"]), solution: new Set(["env"]),
  };
  for (const [section, allowed] of Object.entries(supported)) {
    const values = config[section];
    if (!isObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value === null || Array.isArray(value) && !value.length) continue;
      if (!allowed.has(key)) unsupported.push(`${section}.${key}`);
      else if (key === "network_mode" && value !== "public") unsupported.push(`${section}.network_mode=${String(value)} (no native network isolation)`);
      else if (key === "os" && value !== ({ linux: "linux", win32: "windows" } as Record<string, string>)[process.platform]) unsupported.push(`${section}.os=${String(value)}`);
      else if (key === "environment_mode" && value !== "shared") unsupported.push(`${section}.environment_mode=${String(value)}`);
    }
  }
  return unsupported;
}
export async function readTask(path: string, source: TaskDefinition["source"] = "workspace"): Promise<TaskDefinition> {
  const root = await realpath(path), raw = parse(await readFile(await containedPath(root, "task.toml"), "utf8"));
  if (!isObject(raw) || raw.schema_version !== undefined && raw.schema_version !== "1.4" || "version" in raw) throw new Error("Expected Harbor Task schema_version 1.4 (no legacy version alias)");
  if (!isObject(raw.task) || typeof raw.task.name !== "string") throw new Error("Ludens tasks require [task].name");
  for (const key of ["metadata", "agent", "verifier", "environment", "solution"]) if (raw[key] !== undefined && !isObject(raw[key])) throw new Error(`${key} must be a TOML table`);
  for (const key of ["agent", "verifier"]) {
    const value = raw[key] as Record<string, unknown> | undefined;
    if (value?.timeout_sec !== undefined && (typeof value.timeout_sec !== "number" || !Number.isFinite(value.timeout_sec) || value.timeout_sec <= 0)) throw new Error(`${key}.timeout_sec must be finite and positive`);
  }
  for (const key of ["environment", "verifier", "solution"]) {
    const env = (raw[key] as Record<string, unknown> | undefined)?.env;
    if (env !== undefined && (!isObject(env) || Object.values(env).some(value => typeof value !== "string"))) throw new Error(`${key}.env must contain strings`);
  }
  const config = { ...raw, schema_version: "1.4" } as TaskConfig;
  const { digest, files } = await taskDigest(root);
  validateIdentity({ name: config.task.name, digest, version: config.task.version });
  // Required native inputs must be in the actual immutable package, not just on the source disk.
  for (const required of ["task.toml", "instruction.md", "tests/test.sh"]) if (!files.includes(required)) throw new Error(`Missing or excluded required task input: ${required}`);
  if (!(await stat(join(root, "environment")).catch(() => undefined))?.isDirectory() && !config.environment?.docker_image) throw new Error("Task requires environment/ (or a declared environment.docker_image)");
  const unsupportedRequirements = nativeRequirements(config);
  for (const name of ["Dockerfile", "docker-compose.yaml", "docker-compose.yml"]) if (await exists(join(root, "environment", name))) unsupportedRequirements.push(`environment/${name}`);
  return { name: config.task.name, digest, ...(config.task.version ? { version: config.task.version } : {}), path: root,
    title: typeof config.task.description === "string" && config.task.description ? config.task.description : config.task.name,
    source, schemaVersion: "1.4", config, unsupportedRequirements };
}
/** Pin selected small package bytes once. Runtime outputs never become task inputs. */
export async function pinTask(workspace: string, task: TaskDefinition): Promise<TaskDefinition> {
  const canonicalWorkspace = await realpath(workspace);
  const parent = join(canonicalWorkspace, ".rsa", "benchmarks", "tasks"), destination = join(parent, task.digest.slice(7));
  await mkdir(parent, { recursive: true });
  await containedPath(canonicalWorkspace, ".rsa/benchmarks/tasks");
  if (await exists(destination)) {
    await containedPath(canonicalWorkspace, relative(canonicalWorkspace, destination));
    const pinned = await readTask(destination, task.source);
    if (pinned.digest !== task.digest || pinned.name !== task.name) throw new Error("Pinned task package integrity mismatch");
    return pinned;
  }
  const selected = await taskDigest(task.path);
  if (selected.digest !== task.digest) throw new Error("Task changed before pinning");
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.pin-${randomUUID()}`);
  try {
    await mkdir(join(temporary, "environment"), { recursive: true });
    for (const path of selected.files) { const target = join(temporary, path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(task.path, path), target); }
    // Ignore rules affect hashing but are not themselves selected package bytes. Preserve them for revalidation.
    for (const path of [".gitignore"]) if (await exists(join(task.path, path))) await copyFile(join(task.path, path), join(temporary, path));
    const copied = await readTask(temporary, task.source);
    if (copied.digest !== task.digest) throw new Error("Task changed while pinning");
    try { await rename(temporary, destination); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    const pinned = await readTask(destination, task.source);
    if (pinned.digest !== task.digest) throw new Error("Pinned task package integrity mismatch");
    return pinned;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
