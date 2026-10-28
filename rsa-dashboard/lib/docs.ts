import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Docs served to the browser. Paths are fixed; no client input becomes a path. */
const repoRoot = resolve(process.cwd(), "..");
const docsRoot = join(repoRoot, "docs");

export interface DocEntry { id: string; title: string; group: DocGroup; path: string }
export type DocGroup = "tutorials" | "reference" | "insights";
const groups: { id: DocGroup; title: string; blurb: string }[] = [
  { id: "tutorials", title: "教程", blurb: "怎么跑起来。" },
  { id: "reference", title: "介绍", blurb: "组件是什么、怎么运转。" },
  { id: "insights", title: "洞见", blurb: "当时为什么这么做。" },
];

const titles: Record<string, string> = {
  "tutorials/development.md": "开发与运行",
  "tutorials/workspace.md": "Workspace 与自适应代码",
  "reference/architecture.md": "架构与边界",
  "reference/baseware.md": "Baseware 设计理念与能力契约",
  "reference/driver-bridge-protocol.md": "Driver Bridge 协议",
  "reference/logging.md": "日志与调用链",
  "reference/benchmark.md": "Benchmark",
  "insights/omp-compaction.md": "OMP 后台压缩改造",
  "insights/ws-recovery.md": "WS 恢复测试依据",
};

async function listed(group: DocGroup): Promise<DocEntry[]> {
  const dir = join(docsRoot, group);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(name => name.endsWith(".md") && name !== "README.md").sort();
  } catch { return []; }
  return files.map(name => ({ id: `${group}/${name.replace(/\.md$/, "")}`, group,
    title: titles[`${group}/${name}`] ?? name.replace(/\.md$/, ""),
    path: join(dir, name) }));
}

export async function docGroups() {
  return Promise.all(groups.map(async group => ({ ...group,
    docs: (await listed(group.id)).map(({ id, title }) => ({ id, title })) })));
}

/** Resolve a whitelisted doc id to an absolute file; anything else is rejected. */
async function resolveDoc(id: string): Promise<DocEntry> {
  if (!/^(tutorials|reference|insights)\/[a-z0-9-]+$/.test(id)) throw new Error("未知文档");
  for (const group of groups) {
    for (const entry of await listed(group.id)) {
      if (entry.id === id) {
        const absolute = resolve(entry.path);
        if (!absolute.startsWith(docsRoot + sep)) throw new Error("未知文档");
        return { ...entry, path: absolute };
      }
    }
  }
  throw new Error("未知文档");
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (text: string) => text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function inline(text: string): string {
  let out = escape(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    if (/^(https?:|mailto:)/.test(href)) return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
    if (href.endsWith(".md")) {
      const target = href.replace(/\.md$/, "").replace(/^\.\//, "");
      return `<span class="doc-ref" data-doc="${target}">${label}</span>`;
    }
    if (href.startsWith("#")) return `<a href="${href}">${label}</a>`;
    return label;
  });
  return out;
}

/** Minimal markdown renderer: headings, code fences, tables, lists, paragraphs. */
export function renderMarkdown(source: string): string {
  const lines = source.split("\n");
  const html: string[] = [];
  let i = 0, inCode = false, codeLang = "", code: string[] = [];
  let list: string[] | null = null;
  const flushList = () => { if (list) { html.push("<ul>" + list.map(item => `<li>${inline(item)}</li>`).join("") + "</ul>"); list = null; } };
  const flushCode = () => { html.push(`<pre><code${codeLang ? ` class="language-${escape(codeLang)}"` : ""}>${escape(code.join("\n"))}</code></pre>`); code = []; };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushList(); inCode = true; codeLang = fence[1] ?? ""; }
      i++; continue;
    }
    if (inCode) { code.push(line); i++; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length, text = heading[2].trim();
      html.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++; continue;
    }
    const tableRow = line.match(/^\|.*\|\s*$/);
    if (tableRow && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushList();
      const cells = (row: string) => row.slice(1, -1).split("|").map(cell => inline(cell.trim()));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      html.push("<div class=\"doc-table\"><table><thead><tr>" + head.map(h => `<th>${h}</th>`).join("") +
        "</tr></thead><tbody>" + body.map(row => "<tr>" + row.map(c => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { (list ??= []).push(bullet[1]); i++; continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) { (list ??= []).push(ordered[1]); i++; continue; }
    if (/^\s*$/.test(line)) { flushList(); i++; continue; }
    flushList();
    html.push(`<p>${inline(line.trim())}</p>`);
    i++;
  }
  flushList();
  return html.join("\n");
}

/** Rewrite relative repo links (../../rsa/…, ../../baseware/…) into doc ids when possible. */
function rewriteRepoLinks(html: string): string {
  return html.replace(/<span class="doc-ref" data-doc="([^"]+)">/g, (_, target: string) => {
    const clean = target.replace(/^(\.\.\/)+/, "");
    if (/^(rsa|baseware|shared|docs)\//.test(clean)) return `<span class="doc-repo">${clean}</span>`;
    return `<span class="doc-ref" data-doc="${clean}">`;
  });
}

export async function readDoc(id: string): Promise<{ id: string; title: string; group: DocGroup; html: string }> {
  const entry = await resolveDoc(id);
  const source = await readFile(entry.path, "utf8");
  return { id: entry.id, title: entry.title, group: entry.group, html: rewriteRepoLinks(renderMarkdown(source)) };
}
