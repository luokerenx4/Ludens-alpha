import { readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

/** Docs served to the browser. Paths are fixed; no client input becomes a path. */
const repoRoot = resolve(process.cwd(), "..");
const docsRoot = join(repoRoot, "docs");

export interface DocEntry { id: string; title: string; group: DocGroup; path: string }
export type DocGroup = "tutorials" | "reference" | "insights";
const groups: { id: DocGroup; title: string; blurb: string }[] = [
  { id: "tutorials", title: "教程 · Tutorials", blurb: "怎么安装、准备设备与跑通工作区。" },
  { id: "reference", title: "契约 · Reference", blurb: "组件边界、通信协议与日志评测规范。" },
  { id: "insights", title: "洞见 · Insights", blurb: "真实长跑踩坑复盘与架构取舍依据。" },
];

const titles: Record<string, string> = {
  "tutorials/index.md": "教程概览",
  "tutorials/quickstart.md": "安装与工作区启停",
  "tutorials/devices.md": "设备与驱动准备",
  "tutorials/workspace.md": "工作区与能力编程",
  "tutorials/perception-and-action.md": "常驻感知与动作循环",
  "tutorials/debugging-and-verification.md": "控制台调试与验证",
  "reference/index.md": "组件与契约概览",
  "reference/architecture.md": "架构与边界",
  "reference/baseware.md": "Baseware 设计理念与能力契约",
  "reference/driver-bridge-protocol.md": "Driver Bridge 协议",
  "reference/logging.md": "日志与调用链",
  "reference/benchmark.md": "Benchmark",
  "insights/index.md": "洞见概览",
  "insights/omp-compaction.md": "OMP 后台压缩改造",
  "insights/ws-recovery.md": "WS 恢复测试依据",
};
const order = Object.keys(titles);
const rank = (key: string) => { const idx = order.indexOf(key); return idx < 0 ? 999 : idx; };

const docIdPattern = /^(tutorials|reference|insights)\/[a-z0-9-]+$/;

async function listed(group: DocGroup, root: string): Promise<DocEntry[]> {
  const dir = join(root, group);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(name => name.endsWith(".md") && docIdPattern.test(`${group}/${name.slice(0, -3)}`))
      .sort((a, b) => rank(`${group}/${a}`) - rank(`${group}/${b}`) || a.localeCompare(b));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return files.map(name => ({ id: `${group}/${name.replace(/\.md$/, "")}`, group,
    title: titles[`${group}/${name}`] ?? name.replace(/\.md$/, ""),
    path: join(dir, name) }));
}

export async function docGroups(root = docsRoot) {
  return Promise.all(groups.map(async group => ({ ...group,
    docs: (await listed(group.id, root)).map(({ id, title }) => ({ id, title })) })));
}

/** Resolve a whitelisted doc id to an absolute file; anything else is rejected. */
async function resolveDoc(id: string, entries: DocEntry[], root: string): Promise<DocEntry> {
  const entry = entries.find(item => item.id === id);
  if (!entry) throw new Error("未知文档");
  const [absolute, allowedRoot] = await Promise.all([realpath(entry.path), realpath(root)]);
  if (!absolute.startsWith(allowedRoot + sep)) throw new Error("未知文档");
  return { ...entry, path: absolute };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const slug = (text: string) => text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function docTarget(href: string, currentId: string, ids?: ReadonlySet<string>) {
  const hash = href.indexOf("#"), path = hash < 0 ? href : href.slice(0, hash);
  if (/^[a-z][a-z0-9+.-]*:|^\/|[?\\]/i.test(path)) return;
  try {
    const target = path ? posix.normalize(posix.join(posix.dirname(currentId), decodeURIComponent(path))) : `${currentId}.md`;
    if (!target.endsWith(".md")) return;
    const id = target.slice(0, -3);
    if (!docIdPattern.test(id) || (ids && !ids.has(id))) return;
    return { id, anchor: hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1)) };
  } catch { return; }
}

function inline(text: string, currentId: string, ids?: ReadonlySet<string>, links = true): string {
  // Parse source tokens once. Never run Markdown replacements over generated
  // HTML or code spans, where quotes and markup must remain literal text.
  const tokens = /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*/g;
  let html = "", offset = 0;
  for (const match of text.matchAll(tokens)) {
    html += escape(text.slice(offset, match.index));
    if (match[1]) html += `<code>${escape(match[2])}</code>`;
    else if (match[5]) html += `<strong>${inline(match[5], currentId, ids, links)}</strong>`;
    else {
      const label = inline(match[3], currentId, ids, false), href = match[4];
      const target = links ? docTarget(href, currentId, ids) : undefined;
      if (links && /^(https?:|mailto:)/i.test(href)) {
        html += `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      } else if (target) {
        const params = new URLSearchParams({ view: "docs", doc: target.id });
        if (target.anchor) params.set("docAnchor", target.anchor);
        html += `<a class="doc-ref" href="/?${escape(params.toString())}" data-doc="${escape(target.id)}" data-doc-anchor="${escape(target.anchor)}">${label}</a>`;
      } else html += label;
    }
    offset = match.index + match[0].length;
  }
  return html + escape(text.slice(offset));
}

/** Minimal markdown renderer: headings, code fences, tables, lists, paragraphs. */
export function renderMarkdown(source: string, currentId: string, ids?: ReadonlySet<string>): string {
  const lines = source.split("\n");
  const html: string[] = [];
  let i = 0, inCode = false, codeLang = "", code: string[] = [];
  const renderInline = (text: string) => inline(text, currentId, ids);
  const headings = new Map<string, number>();
  let list: string[] | null = null, listTag: "ol" | "ul" = "ul";
  const flushList = () => { if (list) { html.push(`<${listTag}>` + list.map(item => `<li>${renderInline(item)}</li>`).join("") + `</${listTag}>`); list = null; } };
  const flushCode = () => {
    if (codeLang === "mermaid") {
      html.push(`<details class="doc-diagram"><summary>架构与流程图（点击展开源码）</summary><pre><code class="language-mermaid">${escape(code.join("\n"))}</code></pre></details>`);
    } else {
      html.push(`<pre><code${codeLang ? ` class="language-${escape(codeLang)}"` : ""}>${escape(code.join("\n"))}</code></pre>`);
    }
    code = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushList(); inCode = true; codeLang = fence[1] ?? ""; }
      i++; continue;
    }
    if (inCode) { code.push(line); i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length, text = heading[2].trim();
      const base = slug(text), count = headings.get(base) ?? 0;
      headings.set(base, count + 1);
      html.push(`<h${level} id="${base}${count ? `-${count}` : ""}">${renderInline(text)}</h${level}>`);
      i++; continue;
    }
    const tableRow = line.match(/^\|.*\|\s*$/);
    if (tableRow && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushList();
      const cells = (row: string) => row.trim().slice(1, -1).split("|").map(cell => renderInline(cell.trim()));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      html.push("<div class=\"doc-table\"><table><thead><tr>" + head.map(h => `<th>${h}</th>`).join("") +
        "</tr></thead><tbody>" + body.map(row => "<tr>" + row.map(c => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const tag = bullet ? "ul" : "ol";
      if (listTag !== tag) flushList();
      listTag = tag;
      (list ??= []).push((bullet ?? ordered)![1]);
      i++; continue;
    }
    if (/^\s*$/.test(line)) { flushList(); i++; continue; }
    flushList();
    html.push(`<p>${renderInline(line.trim())}</p>`);
    i++;
  }
  flushList();
  if (inCode) flushCode();
  return html.join("\n");
}

export async function readDoc(id: string, root = docsRoot): Promise<{ id: string; title: string; group: DocGroup; html: string }> {
  if (!docIdPattern.test(id)) throw new Error("未知文档");
  const entries = (await Promise.all(groups.map(group => listed(group.id, root)))).flat();
  const entry = await resolveDoc(id, entries, root);
  const source = await readFile(entry.path, "utf8");
  return { id: entry.id, title: entry.title, group: entry.group,
    html: renderMarkdown(source, entry.id, new Set(entries.map(item => item.id))) };
}
