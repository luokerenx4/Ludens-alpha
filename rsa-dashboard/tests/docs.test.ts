import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docGroups, readDoc, renderDocument, renderMarkdown } from "../lib/docs";
import { dashboardWorker } from "../lib/dashboard-worker";
import { GET } from "../app/api/docs/route";

const repositoryDocs = fileURLToPath(new URL("../../docs/", import.meta.url));

test("relative document links retain their group, fragment and a keyboard-accessible URL", () => {
  const html = renderMarkdown([
    "[日志](logging.md#消费与指标解释)",
    "[Workspace](../tutorials/workspace.md#能力留档与-workspace-时空轴)",
    "[本页](#%E7%BB%84%E4%BB%B6)",
    "[概览](./index.md)",
  ].join("\n"), "reference/architecture");
  assert.match(html, /<a class="doc-ref" href="\/\?view=docs&amp;doc=reference%2Flogging&amp;docAnchor=/);
  assert.match(html, /data-doc="reference\/logging" data-doc-anchor="消费与指标解释"/);
  assert.match(html, /data-doc="tutorials\/workspace" data-doc-anchor="能力留档与-workspace-时空轴"/);
  assert.match(html, /data-doc="reference\/architecture" data-doc-anchor="组件"/);
  assert.match(html, /data-doc="reference\/index"/);
  assert.doesNotMatch(html, /<span[^>]*data-doc/);
});

test("Markdown content cannot inject attributes, raw HTML or executable links", () => {
  const html = renderMarkdown([
    '<script>alert("bad")</script>',
    '[quote](https://example.test/"onmouseover="bad)',
    '[query](https://example.test/?a=1&b=2)',
    '[unsafe](javascript:alert)',
    '[data](data:text/html,bad)',
    '[anchor](#%22%20onmouseover%3D%22bad)',
    '```js"onmouseover="bad',
    '<img src=x onerror="bad">',
    '```',
  ].join("\n"), "reference/architecture");
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript:|data:)| onmouseover="| onerror="/);
  assert.match(html, /href="https:\/\/example.test\/&quot;onmouseover=&quot;bad"/);
  assert.match(html, /href="https:\/\/example.test\/\?a=1&amp;b=2"/);
  assert.match(html, /data-doc-anchor="&quot; onmouseover=&quot;bad"/);
  assert.match(html, /class="language-js&quot;onmouseover=&quot;bad"/);
});

test("code stays literal, ordered steps stay ordered, and unfinished fences retain content", () => {
  const html = renderMarkdown([
    '`[not a link](logging.md) **literal**` and [**日志**](logging.md)',
    "1. First", "2. Second", "", "- Bullet", "",
    "## 重复标题", "## 重复标题", "",
    "```python", "print('<unfinished>')",
  ].join("\n"), "reference/architecture");
  assert.match(html, /<code>\[not a link\]\(logging.md\) \*\*literal\*\*<\/code>/);
  assert.match(html, /<a[^>]+data-doc="reference\/logging"[^>]*><strong>日志<\/strong><\/a>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<ul><li>Bullet<\/li><\/ul>/);
  assert.match(html, /id="重复标题"/);
  assert.match(html, /id="重复标题-1"/);
  assert.match(html, /print\(&#39;&lt;unfinished&gt;&#39;\)<\/code><\/pre><\/div>$/);
});

test("heading metadata matches unique HTML anchors and excludes fenced source", () => {
  const rendered = renderDocument([
    "# Document", "## Repeat", "## Repeat-1", "## Repeat", "### **Labels** and `code`", "## 🧭", "## 🧭", "",
    "```md", "## Not an article heading", "```",
  ].join("\n"), "reference/index");
  assert.deepEqual(rendered.headings, [
    { id: "document", text: "Document", level: 1 },
    { id: "repeat", text: "Repeat", level: 2 },
    { id: "repeat-1", text: "Repeat-1", level: 2 },
    { id: "repeat-2", text: "Repeat", level: 2 },
    { id: "labels-and-code", text: "Labels and code", level: 3 },
    { id: "section", text: "🧭", level: 2 },
    { id: "section-1", text: "🧭", level: 2 },
  ]);
  for (const heading of rendered.headings) assert.ok(rendered.html.includes(`<h${heading.level} id="${heading.id}">`));
  assert.equal(new Set(rendered.headings.map(heading => heading.id)).size, rendered.headings.length);
});

test("code-copy metadata retains literal content, whitespace and empty blocks without UI labels", () => {
  const source = ["```sh", "  printf '<tag> & **literal**'", "", "\tcommand --flag=\"quoted\"", "```", "", "```", "```", "", "```mermaid", "graph LR", "  A --> B", "```", "", "```js", "unfinished();", ""].join("\n");
  const rendered = renderDocument(source, "reference/index", undefined, "zh");
  assert.deepEqual(rendered.codeBlocks, [
    { id: "code-1", language: "sh", code: "  printf '<tag> & **literal**'\n\n\tcommand --flag=\"quoted\"" },
    { id: "code-2", language: "", code: "" },
    { id: "code-3", language: "mermaid", code: "graph LR\n  A --> B" },
    { id: "code-4", language: "js", code: "unfinished();\n" },
  ]);
  for (const block of rendered.codeBlocks) {
    assert.ok(rendered.html.includes(`class="doc-code-block" data-doc-code="${block.id}"><div data-doc-code-toolbar="${block.id}"></div><pre>`));
  }
  assert.match(rendered.html, /<details class="doc-diagram"><summary>架构与流程图/);
  assert.doesNotMatch(rendered.html, /<button|<tag>|<strong>literal<\/strong>/);
});

test("only available docs become navigation links; source labels and unsafe paths stay plain", () => {
  const html = renderMarkdown([
    "[available](logging.md)", "[missing](absent.md)",
    "[template](../../rsa/templates/AGENTS.md)",
    "[escape](../../../reference/logging.md)",
    "[encoded escape](%2e%2e/%2e%2e/reference/logging.md)",
  ].join("\n"), "reference/architecture", new Set(["reference/logging"]));
  assert.equal([...html.matchAll(/data-doc=/g)].length, 1);
  assert.match(html, /<p>template<\/p>/);
  assert.match(html, /<p>missing<\/p>/);
  assert.doesNotMatch(html, /doc-repo|rsa\/templates/);
});

test("current repository documents and their internal section links all resolve", async () => {
  for (const lang of ["en", "zh"] as const) {
    const groups = await docGroups(repositoryDocs, lang);
    for (const group of groups) assert.equal(group.docs[0]?.id, `${group.id}/index`);
    const documents = await Promise.all(groups.flatMap(group => group.docs.map(doc => readDoc(doc.id, repositoryDocs, lang))));
    const byId = new Map(documents.filter(doc => !doc.fallback).map(doc => [doc.id, doc]));
    let links = 0, anchoredLinks = 0;
    for (const doc of documents) {
      if (doc.fallback) continue;
      for (const match of doc.html.matchAll(/data-doc="([^"]+)" data-doc-anchor="([^"]*)"/g)) {
        links++;
        const target = byId.get(match[1]);
        assert.ok(target, `${doc.id} links to missing ${match[1]}`);
        if (match[2]) {
          anchoredLinks++;
          assert.ok(target.html.includes(`id="${match[2]}"`), `${doc.id} links to missing section ${match[1]}#${match[2]}`);
        }
      }
    }
    assert.ok(links > 20);
    assert.ok(anchoredLinks >= 3);
  }
});

test("localized catalogs use translated titles and disclose missing languages symmetrically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs");
  try {
    for (const lang of ["en", "zh"]) await mkdir(join(root, lang, "reference"), { recursive: true });
    await writeFile(join(root, "en/reference/index.md"), "# Overview\n");
    await writeFile(join(root, "zh/reference/index.md"), "# 概览\n");
    await writeFile(join(root, "en/reference/english-only.md"), "# English only\n");
    await writeFile(join(root, "zh/reference/chinese-only.md"), "# 仅中文\n");
    const en = await docGroups(root, "en"), zh = await docGroups(root, "zh");
    assert.deepEqual(en.map(group => group.title), ["Tutorials", "Reference", "Insights"]);
    assert.deepEqual(zh.map(group => group.title), ["教程", "参考", "分析"]);
    for (let i = 0; i < en.length; i++) assert.notEqual(en[i].blurb, zh[i].blurb);
    assert.deepEqual(en[1].docs, [
      { id: "reference/index", title: "Overview", lang: "en", fallback: false, availableLanguages: ["en", "zh"] },
      { id: "reference/chinese-only", title: "仅中文", lang: "zh", fallback: true, availableLanguages: ["zh"] },
      { id: "reference/english-only", title: "English only", lang: "en", fallback: false, availableLanguages: ["en"] },
    ]);
    assert.deepEqual(zh[1].docs, [
      { id: "reference/index", title: "概览", lang: "zh", fallback: false, availableLanguages: ["en", "zh"] },
      { id: "reference/chinese-only", title: "仅中文", lang: "zh", fallback: false, availableLanguages: ["zh"] },
      { id: "reference/english-only", title: "English only", lang: "en", fallback: true, availableLanguages: ["en"] },
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both fallback directions retain requested language in internal and new-tab links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs");
  try {
    for (const lang of ["en", "zh"]) await mkdir(join(root, lang, "reference"), { recursive: true });
    await writeFile(join(root, "en/reference/english-only.md"), "# English only\n[中文](chinese-only.md#小节)\n[Section](#section)\n## Section\n");
    await writeFile(join(root, "zh/reference/chinese-only.md"), "# 仅中文\n[English](english-only.md#section)\n[小节](#小节)\n## 小节\n");
    for (const [requestedLang, id, actual] of [["en", "reference/chinese-only", "zh"], ["zh", "reference/english-only", "en"]] as const) {
      const doc = await readDoc(id, root, requestedLang);
      assert.equal(doc.lang, actual); assert.equal(doc.requestedLang, requestedLang); assert.equal(doc.fallback, true);
      const links = [...doc.html.matchAll(/href="([^"]+)"/g)]; assert.equal(links.length, 2);
      for (const [, href] of links) {
        const query = new URL(href.replaceAll("&amp;", "&"), "http://localhost").searchParams;
        assert.equal(query.get("docLang"), requestedLang); assert(query.get("docAnchor"));
      }
      assert.match(doc.html, new RegExp(`data-doc-lang="${requestedLang}"`));
      const native = await readDoc(id, root, actual); assert.equal(native.lang, actual); assert.equal(native.fallback, false);
    }
    assert.equal((await readDoc("reference/chinese-only", root)).requestedLang, "en");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("document reads reject traversal and symlinks outside the docs tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs");
  try {
    await mkdir(join(root, "en/reference"), { recursive: true });
    await writeFile(join(root, "en/reference/index.md"), "# Overview\n");
    await writeFile(join(directory, "outside.md"), "# Private title\nprivate fixture");
    await symlink(join(directory, "outside.md"), join(root, "en/reference/escape.md"));
    assert.equal((await readDoc("reference/index", root)).title, "Overview");
    assert.deepEqual((await docGroups(root))[1].docs.map(doc => doc.id), ["reference/index"]);
    assert.doesNotMatch(JSON.stringify(await docGroups(root)), /Private title|private fixture/);
    for (const id of ["reference/../outside", "../outside", "reference/index.md", "history/old", "reference/escape"]) {
      await assert.rejects(readDoc(id, root), /Unknown doc/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a symlinked language root cannot expose files outside the documentation tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs"), outside = join(directory, "outside");
  try {
    await mkdir(root); await mkdir(join(outside, "reference"), { recursive: true });
    await writeFile(join(outside, "reference/index.md"), "# Private title\n");
    await symlink(outside, join(root, "en"));
    assert.deepEqual((await docGroups(root)).flatMap(group => group.docs), []);
    await assert.rejects(readDoc("reference/index", root), /Unknown doc/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Docs GET carries the requested language through the real worker without accepting a client file path", async () => {
  const request = (query: string, host = "localhost:3015") => new Request(`http://${host}/api/docs?${query}`, { headers: { host } });
  try {
    const forbidden = await GET(request("lang=zh", "untrusted.test")); assert.equal(forbidden.status, 400);
    const en = await GET(request("lang=en")), zh = await GET(request("lang=zh"));
    assert.equal(en.status, 200); assert.equal(zh.status, 200);
    const enCatalog = await en.json(), zhCatalog = await zh.json();
    assert.equal(enCatalog[0].title, "Tutorials"); assert.equal(zhCatalog[0].title, "教程");
    assert.notEqual(enCatalog[0].docs[0].title, zhCatalog[0].docs[0].title);
    const response = await GET(request("doc=reference%2Findex&lang=zh&root=%2Fnot-a-docs-root"));
    assert.equal(response.status, 200);
    const doc = await response.json(); assert.equal(doc.requestedLang, "zh"); assert.equal(doc.lang, "zh");
    assert(Array.isArray(doc.headings)); assert(Array.isArray(doc.codeBlocks));
    for (const [, href] of doc.html.matchAll(/class="doc-ref" href="([^"]+)"/g)) assert.match(href, /docLang=zh/);
    assert.equal((await GET(request("doc=..%2Fsecret&lang=zh"))).status, 400);
  } finally { await dashboardWorker().close(); }
});
