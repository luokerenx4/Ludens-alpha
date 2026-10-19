import type { LogBlock } from "@/lib/activity";

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

/** Filtering never loses the block targeted by a Pet/detail deep link. */
export function activityPage(
  blocks: LogBlock[],
  filter: ActivityFilter,
  query: string,
  limit: number,
  selected?: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = blocks.filter((block) => {
    if (filter === "all" ? block.kind === "diagnostic" : block.kind !== filter)
      return false;
    return (
      !needle ||
      [
        block.title,
        block.text,
        blockLabels[block.kind],
        block.source?.component,
        block.source?.implementation,
        printable(block.tool),
        block.id,
      ]
        .filter(Boolean)
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle)
    );
  });
  const page = filtered.slice(-limit);
  const selectedBlock = selected
    ? blocks.find((block) => block.id === selected)
    : undefined;
  const pinned =
    selectedBlock && !page.some((block) => block.id === selectedBlock.id)
      ? selectedBlock
      : undefined;
  return {
    page,
    pinned,
    total: filtered.length,
    remaining: Math.max(0, filtered.length - limit),
    missingSelection: Boolean(selected && !selectedBlock),
  };
}
