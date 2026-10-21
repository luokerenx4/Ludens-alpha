import type { LogBlock } from "@/lib/activity";
import type { ActivityBlock } from "../lib/activity-client";
export { sameScope, acceptsScope } from "../lib/activity-client";
export type { ActivityBlock, ActivityScope } from "../lib/activity-client";

export type ActivityFilter = "all" | LogBlock["kind"];

export const blockLabels: Record<LogBlock["kind"], string> = {
  thinking: "思考",
  text: "文本",
  tool: "工具",
  system: "系统",
  diagnostic: "诊断",
};

export function printable(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}

/** Shared by the server projection and incremental UI, never a full-run filter. */
export function activitySearchText(block: LogBlock): string {
  return [block.title, block.text, blockLabels[block.kind],
    block.source?.component, block.source?.implementation, printable(block.tool), block.id]
    .filter(Boolean).join("\n").toLocaleLowerCase();
}

export function matchesActivity(block: LogBlock, filter: ActivityFilter, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (filter === "all" ? block.kind !== "diagnostic" : block.kind === filter)
    && (!needle || activitySearchText(block).includes(needle));
}

export const ACTIVITY_PAGE_SIZE = 100;
export const ACTIVITY_WINDOW_SIZE = 300;
export const ACTIVITY_LIVE_SIZE = 200;

export function newerBlock(left: ActivityBlock | undefined, right: ActivityBlock): ActivityBlock {
  return left && left.revision > right.revision ? left : right;
}

const lexical = (left: string, right: string) => left === right ? 0 : left < right ? -1 : 1;
const byPosition = (left: ActivityBlock, right: ActivityBlock) =>
  lexical(left.at, right.at) || lexical(left.id, right.id);

/** The input is an already bounded server page/window, not the complete log. */
export function mergeActivity(
  blocks: ActivityBlock[], updates: ActivityBlock[],
  options: { filter: ActivityFilter; query: string; append: boolean; keep: "oldest" | "latest"; limit: number },
): ActivityBlock[] {
  const merged = new Map(blocks.map(block => [block.id, block]));
  for (const update of updates) {
    const previous = merged.get(update.id);
    if (!previous && !options.append) continue;
    const next = newerBlock(previous, update);
    if (matchesActivity(next, options.filter, options.query)) merged.set(next.id, next);
    else merged.delete(next.id);
  }
  const sorted = [...merged.values()].filter(block => matchesActivity(block, options.filter, options.query)).sort(byPosition);
  return options.keep === "oldest" ? sorted.slice(0, options.limit) : sorted.slice(-options.limit);
}
