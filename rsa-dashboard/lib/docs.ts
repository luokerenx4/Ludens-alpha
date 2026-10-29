import { readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

/** Docs served to the browser. Paths are fixed; no client input becomes a path. */
const repoRoot = resolve(process.cwd(), "..");
const docsRoot = join(repoRoot, "docs");

export interface DocEntry { id: string; title: string; group: DocGroup; path: string; lang: "en" | "zh" }
export type DocGroup = "tutorials" | "reference" | "insights";
const groups: { id: DocGroup; title: string; blurb: string }[] = [
  { id: "tutorials", title: "Tutorials", blurb: "Install, prepare devices, and run a workspace." },
  { id: "reference", title: "Reference", blurb: "Component boundaries, protocols, and logging/eval specs." },
  { id: "insights", title: "Insights", blurb: "Postmortems from long runs and architecture rationale." },
];

const order = [
  "tutorials/index", "tutorials/quickstart", "tutorials/devices", "tutorials/workspace",
  "tutorials/perception-and-action", "tutorials/debugging-and-verification",
  "reference/index", "reference/architecture", "reference/baseware",
  "reference/driver-bridge-protocol", "reference/logging", "reference/dashboard-ui", "reference/benchmark",
  "insights/index", "insights/omp-compaction", "insights/ws-recovery", "insights/omp-injection",
];
const rank = (key: string) => { const idx = order.indexOf(key); return idx < 0 ? 999 : idx; };

const docIdPattern = /^(tutorials|reference|insights)\/[a-z0-9-]+$/;

async function fileTitle(path: string, fallback: string): Promise<string> {
  try {
    const source = await readFile(path, "utf8");
    const heading = source.match(/^#\s+(.+)$/m);
    const title = heading?.[1].trim();
    return title ? title : fallback;
  } catch { return fallback; }
}

async function listed(group: DocGroup, root: string, lang: "en" | "zh"): Promise<DocEntry[]> {
  const dir = join(root, lang, group);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(name => name.endsWith(".md") && docIdPattern.test(`${group}/${name.slice(0, -3)}`))
      .sort((a, b) => rank(`${group}/${a.slice(0, -3)}`) - rank(`${group}/${b.slice(0, -3)}`) || a.localeCompare(b));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(files.map(async name => {
    const id = `${group}/${name.replace(/\.md$/, "")}`;
    return { id, group, lang, path: join(dir, name),
      title: await fileTitle(join(dir, name), id) };
  }));
}

export async function docGroups(root = docsRoot) {
  return Promise.all(groups.map(async group => {
    const [en, zh] = await Promise.all([listed(group.id, root, "en"), listed(group.id, root, "zh")]);
    const zhIds = new Set(zh.map(item => item.id));
    const merged = new Map<string, DocEntry & { zhAvailable: boolean; enMissing?: boolean }>(
      en.map(item => [item.id, { ...item, zhAvailable: true }]));
    for (const item of zh) if (!merged.has(item.id)) merged.set(item.id, { ...item, zhAvailable: true, enMissing: true });
    for (const item of merged.values()) if (!zhIds.has(item.id)) item.zhAvailable = false;
    const docs = [...merged.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
      .map(({ id, title }) => ({ id, title }));
    return { ...group, docs };
  }));
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
export function renderMarkdown(source: string, currentId: string, ids?: ReadonlySet<string>, lang: "en" | "zh" = "en"): string {
  const lines = source.split("\n");
  const html: string[] = [];
  let i = 0, inCode = false, codeLang = "", code: string[] = [];
  const renderInline = (text: string) => inline(text, currentId, ids);
  const headings = new Map<string, number>();
  let list: string[] | null = null, listTag: "ol" | "ul" = "ul";
  const flushList = () => { if (list) { html.push(`<${listTag}>` + list.map(item => `<li>${renderInline(item)}</li>`).join("") + `</${listTag}>`); list = null; } };
  const flushCode = () => {
    if (codeLang === "mermaid") {
      html.push(`<details class="doc-diagram"><summary>${lang === "zh" ? "架构与流程图（点击展开源码）" : "Architecture diagram (click to expand source)"}</summary><pre><code class="language-mermaid">${escape(code.join("\n"))}</code></pre></details>`);
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

export async function readDoc(id: string, root = docsRoot, lang: "en" | "zh" = "en"): Promise<{ id: string; title: string; group: DocGroup; lang: "en" | "zh"; fallback: boolean; html: string }> {
  if (!docIdPattern.test(id)) throw new Error("Unknown doc");
  const pick = async (want: "en" | "zh") => {
    const entries = (await Promise.all(groups.map(group => listed(group.id, root, want)))).flat();
    const entry = entries.find(item => item.id === id);
    if (!entry) return undefined;
    const [absolute, allowedRoot] = await Promise.all([realpath(entry.path), realpath(join(root, want))]);
    if (!absolute.startsWith(allowedRoot + sep)) throw new Error("Unknown doc");
    return { ...entry, path: absolute };
  };
  const entry = (await pick(lang)) ?? (lang === "en" ? await pick("zh") : undefined);
  if (!entry) throw new Error("Unknown doc");
  const source = await readFile(entry.path, "utf8");
  const ids = new Set((await Promise.all(groups.map(group => listed(group.id, root, entry.lang)))).flat().map(item => item.id));
  return { id: entry.id, title: entry.title, group: entry.group, lang: entry.lang,
    fallback: entry.lang !== lang, html: renderMarkdown(source, entry.id, ids, entry.lang) };
}
