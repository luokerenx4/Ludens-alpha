import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/harness/workspace.ts";

test("skill and script edits update the next index while preserving earlier evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-skills-"));
  const root = join(directory, "workspace");
  await mkdir(join(root, "skills", "turn", "scripts"), { recursive: true });
  const workspace = new Workspace(root, join(directory, "state", "skill-versions"));
  try {
    expect((await workspace.snapshot()).skills).toEqual([]);
    await writeFile(join(root, "skills/turn/SKILL.md"), "---\nname: turn\ndescription: A learned operation\n---\nObserved turn after command.");
    await writeFile(join(root, "skills/turn/scripts/run.sh"), "baseware controller joint rotate 10\n");
    const first = await workspace.snapshot();
    const oldManifest = JSON.parse(await readFile(join(workspace.versions, `${first.version}.json`), "utf8"));
    await writeFile(join(root, "skills/turn/scripts/run.sh"), "baseware controller joint rotate 20\n");
    const second = await workspace.snapshot();
    expect(second.skills[0].version).not.toBe(first.skills[0].version);
    expect(await readFile(join(workspace.versions, oldManifest["skills/turn/scripts/run.sh"]), "utf8")).toContain("rotate 10");
    await writeFile(join(root, "skills/turn/SKILL.md"), "No frontmatter");
    const invalid = await workspace.snapshot();
    expect(invalid.skills).toEqual([]);
    expect(invalid.diagnostics[0]).toContain("name and description");
  } finally { await rm(directory, { recursive: true }); }
});

test("memory snapshots retain earlier content independently of skill versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-memory-"));
  const root = join(directory, "workspace");
  await mkdir(join(root, "skills", "turn"), { recursive: true });
  const workspace = new Workspace(root, join(directory, "state", "skill-versions"));
  try {
    await writeFile(join(root, "skills/turn/SKILL.md"), "---\nname: turn\ndescription: A learned operation\n---\nObserved turn after command.");
    const empty = await workspace.snapshot();
    expect(empty.memory.files).toEqual([]);
    expect(JSON.parse(await readFile(join(workspace.versions, `${empty.memory.version}.json`), "utf8"))).toEqual({});

    await mkdir(join(root, "memory", "observations"), { recursive: true });
    const notePath = join(root, "memory/observations/turn.md");
    const original = "Initial observation: 10°\n";
    await writeFile(notePath, original);
    const first = await workspace.snapshot();
    expect(first.version).toBe(empty.version);
    expect(first.skills).toEqual(empty.skills);
    expect(first.memory.version).not.toBe(empty.memory.version);
    expect(first.memory.files).toEqual([{ path: notePath, version: expect.any(String), bytes: Buffer.byteLength(original) }]);
    const oldManifest = JSON.parse(await readFile(join(workspace.versions, `${first.memory.version}.json`), "utf8"));
    expect(oldManifest).toEqual({ "memory/observations/turn.md": first.memory.files[0].version });

    await writeFile(notePath, "Updated observation: 20°\n");
    const second = await workspace.snapshot();
    expect(second.version).toBe(first.version);
    expect(second.skills).toEqual(first.skills);
    expect(second.memory.version).not.toBe(first.memory.version);
    expect(second.memory.files[0].version).not.toBe(first.memory.files[0].version);
    expect(await readFile(join(workspace.versions, oldManifest["memory/observations/turn.md"]), "utf8")).toBe(original);
    expect((await workspace.snapshot()).memory).toEqual(second.memory);

    await rm(join(root, "memory"), { recursive: true });
    const removed = await workspace.snapshot();
    expect(removed.memory).toEqual(empty.memory);
    expect(removed.version).toBe(first.version);
    expect(removed.skills).toEqual(first.skills);
  } finally { await rm(directory, { recursive: true }); }
});
