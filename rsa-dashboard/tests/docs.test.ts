import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docGroups, readDoc, renderMarkdown } from "../lib/docs";

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
  assert.match(html, /print\(&#39;&lt;unfinished&gt;&#39;\)<\/code><\/pre>$/);
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
    const groups = await docGroups(repositoryDocs);
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

test("english-first read falls back to chinese when the translation is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs");
  try {
    await mkdir(join(root, "zh/reference"), { recursive: true });
    await writeFile(join(root, "zh/reference/index.md"), "# 概览\n");
    const doc = await readDoc("reference/index", root);
    assert.equal(doc.lang, "zh");
    assert.equal(doc.fallback, true);
    assert.equal(doc.title, "概览");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("document reads reject traversal and symlinks outside the docs tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-docs-"));
  const root = join(directory, "docs");
  try {
    await mkdir(join(root, "en/reference"), { recursive: true });
    await writeFile(join(root, "en/reference/index.md"), "# Overview\n");
    await writeFile(join(directory, "outside.md"), "private fixture");
    await symlink(join(directory, "outside.md"), join(root, "en/reference/escape.md"));
    assert.equal((await readDoc("reference/index", root)).title, "Overview");
    for (const id of ["reference/../outside", "../outside", "reference/index.md", "history/old", "reference/escape"]) {
      await assert.rejects(readDoc(id, root), /Unknown doc/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
