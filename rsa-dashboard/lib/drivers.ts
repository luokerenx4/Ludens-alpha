import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");

export interface DiscoveredDriver {
  spec: string;
  id: string;
  version: string;
  transport?: string;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  launchCommand?: string[];
  launchEnv?: Record<string, string>;
}

/** Import a trusted package's registration; the framework never calls load(). */
export async function discoverDriver(spec: string, signal?: AbortSignal): Promise<DiscoveredDriver> {
  if (typeof spec !== "string") throw Object.assign(new Error("驱动包地址必须是字符串"), { status: 400 });
  const text = spec.trim();
  if (!text) throw Object.assign(new Error("请输入 driver 包地址（npm 名、github:org/repo#rev 或 file: 路径）"), { status: 400 });
  if (text.length > 500) throw Object.assign(new Error("包地址过长"), { status: 400 });
  if (text.startsWith("file:") && !isAbsolute(text.slice(5).trim())) {
    throw Object.assign(new Error("Dashboard 的 file: 包地址必须使用绝对路径"), { status: 400 });
  }
  signal?.throwIfAborted();
  const bin = join(repoRoot, "baseware", "bin", "baseware");
  const child = spawn(bin, ["driver", "discover", "--package", text], {
    cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [], errors: Buffer[] = [];
  let bytes = 0, failure: unknown, terminating = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const kill = (name: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = (reason: unknown) => {
    if (terminating) return;
    terminating = true; failure = reason;
    kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const aborted = () => stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  // Leave time for process cleanup before the worker's 60-second deadline.
  const timeout = setTimeout(() => stop(Object.assign(new Error("驱动验证超时"), { status: 504 })), 55_000);
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) stop(Object.assign(new Error("驱动验证输出过大"), { status: 502 }));
    else target.push(chunk);
  };
  child.stdout.on("data", chunk => collect(output, chunk));
  child.stderr.on("data", chunk => collect(errors, chunk));
  child.once("exit", () => {
    // Imports and installers may create children or leave inherited pipes open.
    // Discovery owns this group even when the registration import succeeds.
    clearTimeout(forced);
    kill("SIGKILL");
  });
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  let stdout: string;
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    if (failure) throw failure;
    if (code !== 0) throw Object.assign(new Error(Buffer.concat(errors).toString("utf8").trim() || `驱动验证进程退出 (${code})`), { status: 400 });
    stdout = Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timeout); clearTimeout(forced);
    signal?.removeEventListener("abort", aborted);
    kill("SIGKILL");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("驱动探测返回了无法解析的结果"), { status: 502 });
  }
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || !record.id) {
    throw Object.assign(new Error("驱动包不符合约定：缺少 driver id"), { status: 422 });
  }
  return { ...value as DiscoveredDriver, spec: text };
}
