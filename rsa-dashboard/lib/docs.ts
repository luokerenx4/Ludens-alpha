import { readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

/** Docs served to the browser. Paths are fixed; no client input becomes a path. */
const repoRoot = resolve(process.cwd(), "..");
const docsRoot = join(repoRoot, "docs");

export type DocLanguage = "en" | "zh";
export interface DocEntry { id: string; title: string; group: DocGroup; path: string; lang: DocLanguage }
export type DocGroup = "tutorials" | "reference" | "insights";
export interface DocHeading { id: string; text: string; level: number }
export interface DocCodeBlock { id: string; language: string; code: string }
export interface DocSummary { id: string; title: string; lang: DocLanguage; fallback: boolean; availableLanguages: DocLanguage[] }
export interface DocGroupInfo { id: DocGroup; title: string; blurb: string; docs: DocSummary[] }
export interface DocDetail {
  id: string; title: string; group: DocGroup; requestedLang: DocLanguage; lang: DocLanguage; fallback: boolean;
  html: string; headings: DocHeading[]; codeBlocks: DocCodeBlock[];
}
const groups: { id: DocGroup; labels: Record<DocLanguage, { title: string; blurb: string }> }[] = [
  { id: "tutorials", labels: {
    en: { title: "Tutorials", blurb: "Install, prepare devices, and run a workspace." },
    zh: { title: "教程", blurb: "安装、准备设备并运行工作区。" },
  } },
  { id: "reference", labels: {
    en: { title: "Reference", blurb: "Component boundaries, protocols, and logging/eval specs." },
    zh: { title: "参考", blurb: "组件边界、协议，以及日志与评测规范。" },
  } },
  { id: "insights", labels: {
    en: { title: "Insights", blurb: "Postmortems from long runs and architecture rationale." },
    zh: { title: "分析", blurb: "长时间运行复盘与架构设计说明。" },
  } },
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

async function listed(group: DocGroup, root: string, lang: DocLanguage): Promise<DocEntry[]> {
  const dir = join(root, lang, group);
  let files: string[], allowedRoot: string;
  try {
    const [absoluteRoot, languageRoot] = await Promise.all([realpath(root), realpath(join(root, lang))]);
    if (!languageRoot.startsWith(absoluteRoot + sep)) return [];
    allowedRoot = languageRoot;
    files = (await readdir(dir)).filter(name => name.endsWith(".md") && docIdPattern.test(`${group}/${name.slice(0, -3)}`))
      .sort((a, b) => rank(`${group}/${a.slice(0, -3)}`) - rank(`${group}/${b.slice(0, -3)}`) || a.localeCompare(b));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries = await Promise.all(files.map(async (name): Promise<DocEntry | null> => {
    const id = `${group}/${name.replace(/\.md$/, "")}`;
    let path: string;
    try { path = await realpath(join(dir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    // Check before reading even the title: a catalog must not expose an outside file.
    if (!path.startsWith(allowedRoot + sep)) return null;
    return { id, group, lang, path, title: await fileTitle(path, id) };
  }));
  return entries.filter((entry): entry is DocEntry => entry !== null);
}

export async function docGroups(root = docsRoot, lang: DocLanguage = "en"): Promise<DocGroupInfo[]> {
  return Promise.all(groups.map(async group => {
    const [en, zh] = await Promise.all([listed(group.id, root, "en"), listed(group.id, root, "zh")]);
    const primary = lang === "en" ? en : zh, secondary = lang === "en" ? zh : en;
    const merged = new Map(primary.map(item => [item.id, item]));
    for (const item of secondary) if (!merged.has(item.id)) merged.set(item.id, item);
    const available = { en: new Set(en.map(item => item.id)), zh: new Set(zh.map(item => item.id)) };
    const docs = [...merged.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
      .map(item => ({ id: item.id, title: item.title, lang: item.lang, fallback: item.lang !== lang,
        availableLanguages: (["en", "zh"] as const).filter(language => available[language].has(item.id)) }));
    return { id: group.id, ...group.labels[lang], docs };
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

const inlineTokens = /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*/g;
function plainInline(text: string): string {
  return text.replace(inlineTokens, (_match, codeFence: string, code: string, label: string, _href: string, bold: string) =>
    codeFence ? code : plainInline(label ?? bold));
}

function inline(text: string, currentId: string, ids: ReadonlySet<string> | undefined, lang: DocLanguage, links = true): string {
  // Parse source tokens once. Never run Markdown replacements over generated
  // HTML or code spans, where quotes and markup must remain literal text.
  let html = "", offset = 0;
  for (const match of text.matchAll(inlineTokens)) {
    html += escape(text.slice(offset, match.index));
    if (match[1]) html += `<code>${escape(match[2])}</code>`;
    else if (match[5]) html += `<strong>${inline(match[5], currentId, ids, lang, links)}</strong>`;
    else {
      const label = inline(match[3], currentId, ids, lang, false), href = match[4];
      const target = links ? docTarget(href, currentId, ids) : undefined;
      if (links && /^(https?:|mailto:)/i.test(href)) {
        html += `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      } else if (target) {
        const params = new URLSearchParams({ view: "docs", doc: target.id });
        if (target.anchor) params.set("docAnchor", target.anchor);
        params.set("docLang", lang);
        html += `<a class="doc-ref" href="/?${escape(params.toString())}" data-doc="${escape(target.id)}" data-doc-anchor="${escape(target.anchor)}" data-doc-lang="${lang}">${label}</a>`;
      } else html += label;
    }
    offset = match.index + match[0].length;
  }
  return html + escape(text.slice(offset));
}

/** Minimal escaped renderer, with metadata from the same pass as the HTML. */
export function renderDocument(source: string, currentId: string, ids?: ReadonlySet<string>, lang: DocLanguage = "en"): Pick<DocDetail, "html" | "headings" | "codeBlocks"> {
  const lines = source.split("\n");
  const html: string[] = [];
  let i = 0, inCode = false, codeLang = "", code: string[] = [];
  const renderInline = (text: string) => inline(text, currentId, ids, lang);
  const headings: DocHeading[] = [], codeBlocks: DocCodeBlock[] = [];
  const headingCounts = new Map<string, number>(), headingIds = new Set<string>();
  let list: string[] | null = null, listTag: "ol" | "ul" = "ul";
  const flushList = () => { if (list) { html.push(`<${listTag}>` + list.map(item => `<li>${renderInline(item)}</li>`).join("") + `</${listTag}>`); list = null; } };
  const flushCode = () => {
    // Copy exactly the joined content lines: retain indentation and blank lines,
    // excluding fence delimiters and the newline that introduces the closing fence.
    const id = `code-${codeBlocks.length + 1}`, text = code.join("\n");
    codeBlocks.push({ id, language: codeLang, code: text });
    const block = `<div class="doc-code-block" data-doc-code="${id}"><div data-doc-code-toolbar="${id}"></div><pre><code${codeLang ? ` class="language-${escape(codeLang)}"` : ""}>${escape(text)}</code></pre></div>`;
    if (codeLang === "mermaid") {
      html.push(`<details class="doc-diagram"><summary>${lang === "zh" ? "架构与流程图（点击展开源码）" : "Architecture diagram (click to expand source)"}</summary>${block}</details>`);
    } else {
      html.push(block);
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
      const base = slug(text) || "section";
      let count = headingCounts.get(base) ?? 0, id = base;
      while (headingIds.has(id)) { count++; id = `${base}-${count}`; }
      headingCounts.set(base, count); headingIds.add(id);
      headings.push({ id, level, text: plainInline(text) });
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
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
  return { html: html.join("\n"), headings, codeBlocks };
}

export function renderMarkdown(source: string, currentId: string, ids?: ReadonlySet<string>, lang: DocLanguage = "en"): string {
  return renderDocument(source, currentId, ids, lang).html;
}

export async function readDoc(id: string, root = docsRoot, lang: DocLanguage = "en"): Promise<DocDetail> {
  if (!docIdPattern.test(id)) throw new Error("Unknown doc");
  const entries = (await Promise.all(groups.flatMap(group => (["en", "zh"] as const).map(language => listed(group.id, root, language))))).flat();
  const entry = entries.find(item => item.id === id && item.lang === lang) ?? entries.find(item => item.id === id);
  if (!entry) throw new Error("Unknown doc");
  const [absolute, allowedRoot] = await Promise.all([realpath(entry.path), realpath(join(root, entry.lang))]);
  if (!absolute.startsWith(allowedRoot + sep)) throw new Error("Unknown doc");
  const source = await readFile(entry.path, "utf8");
  const ids = new Set(entries.map(item => item.id));
  return { id: entry.id, title: entry.title, group: entry.group, requestedLang: lang, lang: entry.lang,
    fallback: entry.lang !== lang, ...renderDocument(source, entry.id, ids, lang) };
}
