import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["app", "components", "lib", "worker", "scripts", "public", "package.json", "package-lock.json",
  "next.config.ts", "tsconfig.json", "postcss.config.mjs", "../shared", "../rsa/src", "../rsa/benchmarks/cases.json"];

export async function sourceHash(root = directory) {
  const hash = createHash("sha256");
  async function visit(path) {
    let entries;
    try { entries = await readdir(join(root, path), { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "ENOTDIR") throw error;
      hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() || entry.isDirectory()) await visit(join(path, entry.name));
    }
  }
  for (const path of sources) await visit(path);
  return hash.digest("hex");
}

export async function stampBuild(root = directory, hash) {
  hash ??= await sourceHash(root);
  const buildId = (await readFile(join(root, ".next/BUILD_ID"), "utf8")).trim();
  await mkdir(join(root, ".next"), { recursive: true });
  await writeFile(join(root, ".next/ludens-build.json"), JSON.stringify({ buildId, hash }) + "\n");
}

export async function checkBuild(root = directory) {
  try {
    const [saved, buildId, hash] = await Promise.all([
      readFile(join(root, ".next/ludens-build.json"), "utf8").then(JSON.parse),
      readFile(join(root, ".next/BUILD_ID"), "utf8"), sourceHash(root),
    ]);
    if (saved.buildId === buildId.trim() && saved.hash === hash) return;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  throw new Error(`Dashboard production build is missing or stale. Run: npm --prefix ${root} run build`);
}

async function next(command, args) {
  const child = spawn(process.execPath, [join(directory, "node_modules/next/dist/bin/next"), command, ...args], {
    cwd: directory, stdio: "inherit", env: process.env,
  });
  const forward = signal => child.kill(signal);
  const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
    if (code !== 0) throw new Error(`Next ${command} exited (${code})`);
  } finally { process.off("SIGTERM", term); process.off("SIGINT", interrupt); }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "build") {
    const before = await sourceHash();
    await next("build", args);
    if (await sourceHash() !== before) throw new Error("Dashboard source changed during build; run the build again.");
    await stampBuild(directory, before);
  } else if (mode === "check") await checkBuild();
  else if (mode === "start") {
    await checkBuild();
    await next("start", ["--hostname", "127.0.0.1", "--port", "3015", ...args]);
  } else throw new Error("Use production.mjs build | check | start");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
