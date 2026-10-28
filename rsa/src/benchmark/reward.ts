import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateRewards, type Rewards } from "./contract.ts";
import { containedPath } from "./task.ts";

/** Harbor JSON has precedence. Invalid JSON never falls back to a stale reward.txt. */
export async function readReward(directory: string): Promise<Rewards> {
  for (const filename of ["reward.json", "reward.txt"] as const) {
    let path: string;
    try { path = await containedPath(directory, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if ((await stat(path)).size > 1024 * 1024) throw new Error("Reward exceeds 1 MiB");
    const text = await readFile(path, "utf8");
    if (filename === "reward.json") { const value: unknown = JSON.parse(text); validateRewards(value); return value; }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim()) || !Number.isFinite(Number(text))) throw new Error("reward.txt must contain one finite number");
    return { reward: Number(text) };
  }
  throw new Error(`Missing verifier reward in ${join(directory, "reward.json")}`);
}
