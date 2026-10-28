import { execFile } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");

export interface DiscoveredDriver {
  id: string;
  version: string;
  transport?: string;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  launchCommand?: string[];
  launchEnv?: Record<string, string>;
}

/** Probe a community driver package spec without connecting any device. Never calls load(). */
export async function discoverDriver(spec: string, signal?: AbortSignal): Promise<DiscoveredDriver> {
  const text = spec.trim();
  if (!text) throw Object.assign(new Error("请输入 driver 包地址（npm 名、github:org/repo#rev 或 file: 路径）"), { status: 400 });
  if (text.length > 500) throw Object.assign(new Error("包地址过长"), { status: 400 });
  const bin = join(repoRoot, "baseware", "bin", "baseware");
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = execFile(bin, ["driver", "discover", "--package", text], {
      // Must stay under the Dashboard worker call timeout (60 s); a cold
      // clone retries into the warm cache, so users can simply retry.
      cwd: repoRoot, signal, timeout: 55_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    }, (error, output, stderr) => {
      if (error) reject(Object.assign(new Error(stderr.trim() || error.message), { status: 400 }));
      else resolveOutput(output);
    });
    child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("驱动探测返回了无法解析的结果"), { status: 502 });
  }
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) {
    throw Object.assign(new Error("驱动包不符合约定：缺少 driver id"), { status: 422 });
  }
  return value as DiscoveredDriver;
}
