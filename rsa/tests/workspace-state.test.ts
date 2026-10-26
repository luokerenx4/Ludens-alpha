import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/harness/workspace.ts";
import { readCurrentSession, resolveWorkspaceState, writeCurrentSession } from "../src/harness/workspace-state.ts";

test("sessions and their selection live in each workspace; registry and versions stay external", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-state-"));
  try {
    const artifacts = join(directory, "artifacts");
    const first = await resolveWorkspaceState(join(directory, "workspaces", "one"), artifacts);
    const second = await resolveWorkspaceState(join(directory, "workspaces", "two"), artifacts);
    expect(first.dir).not.toBe(second.dir);
    expect(first.sessionsDir).not.toBe(second.sessionsDir);
    expect(first.versionsDir).not.toBe(second.versionsDir);
    expect(first.socket).not.toBe(second.socket);
    expect(first.sessionsDir).toBe(join(first.workspace, ".rsa", "shiori", "sessions"));
    expect(await readCurrentSession(first)).toBeUndefined();
    expect(await readCurrentSession(second)).toBeUndefined();

    const firstSession = join(first.sessionsDir, "first.jsonl");
    const secondSession = join(second.sessionsDir, "second.jsonl");
    await writeCurrentSession(first, firstSession);
    await writeCurrentSession(second, secondSession);
    const reopened = await resolveWorkspaceState(first.workspace, artifacts);
    expect(reopened).toEqual(first);
    expect(await readCurrentSession(reopened)).toBe(firstSession);
    expect(await readCurrentSession(second)).toBe(secondSession);

    const replacement = join(first.sessionsDir, "new.jsonl");
    await writeCurrentSession(first, replacement);
    expect(await readCurrentSession(first)).toBe(replacement);
    expect(await readCurrentSession(second)).toBe(secondSession);
    expect(JSON.parse(await readFile(join(first.shioriDir, "current-session.json"), "utf8"))).toEqual({ sessionFile: replacement });
    expect((await readdir(first.shioriDir)).some(name => name.endsWith(".tmp"))).toBe(false);
    expect(await readdir(first.workspace)).toEqual([".rsa"]);
    expect(await readdir(second.workspace)).toEqual([".rsa"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("a symlink and the original workspace resolve to the same identity and socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-alias-"));
  try {
    const original = join(directory, "Game Workspace");
    const alias = join(directory, "alias");
    await mkdir(original);
    await symlink(original, alias);
    const first = await resolveWorkspaceState(original, join(directory, "state"));
    const second = await resolveWorkspaceState(alias, join(directory, "state"));
    expect(first.workspace).toBe(await realpath(original));
    expect(first.id).toMatch(/^ws-game-workspace-[a-f0-9]{16}$/);
    expect(second).toEqual(first);
  } finally { await rm(directory, { recursive: true }); }
});

test("skill and memory snapshots are written outside the task workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-evidence-"));
  try {
    const state = await resolveWorkspaceState(join(directory, "tasks", "workspace"), join(directory, "state"));
    await mkdir(join(state.workspace, "skills", "learned"), { recursive: true });
    await mkdir(join(state.workspace, "memory"));
    await writeFile(join(state.workspace, "skills", "learned", "SKILL.md"), "---\nname: learned\ndescription: Learned method\n---\nMethod.");
    await writeFile(join(state.workspace, "memory", "current.md"), "Current state.\n");
    const index = await new Workspace(state.workspace, state.versionsDir).snapshot();
    expect(await Bun.file(join(state.versionsDir, `${index.version}.json`)).exists()).toBe(true);
    expect(await Bun.file(join(state.versionsDir, `${index.memory.version}.json`)).exists()).toBe(true);
    expect((await readdir(state.workspace)).sort()).toEqual([".rsa", "memory", "skills"]);
    expect(await readdir(join(directory, "tasks"))).toEqual(["workspace"]);
  } finally { await rm(directory, { recursive: true }); }
});
