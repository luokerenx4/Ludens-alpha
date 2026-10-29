import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace } from "../src/harness/workspace.ts";
import { readCurrentSession, initializeWorkspaceState, resolveWorkspaceAddress, resolveWorkspaceState, writeCurrentSession } from "../src/harness/workspace-state.ts";

test("address and state resolution never initialize a bare or missing directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-read-only-"));
  const workspace = join(directory, "bare"), alias = join(directory, "alias"), home = join(directory, "home");
  await mkdir(workspace); await symlink(workspace, alias);
  try {
    expect(await resolveWorkspaceAddress(alias)).toEqual(await resolveWorkspaceAddress(workspace));
    await expect(resolveWorkspaceState(workspace, home)).rejects.toThrow("rsa workspace import");
    await expect(resolveWorkspaceState(join(directory, "missing"), home)).rejects.toThrow("rsa init");
    expect(await readdir(workspace)).toEqual([]);
    expect(await Bun.file(join(workspace, ".rsa", "workspace.json")).exists()).toBe(false);
    expect((await readdir(directory)).sort()).toEqual(["alias", "bare"]);
    const state = await initializeWorkspaceState(workspace, home);
    await rm(state.sessionsDir, { recursive: true });
    expect(await resolveWorkspaceState(workspace, home)).toEqual(state);
    expect(await readdir(state.shioriDir)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI queries and direct run cannot create an identity in an uninitialized directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-query-init-"));
  const workspace = join(directory, "bare"), home = join(directory, "home");
  await mkdir(workspace);
  const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
  for (const key of ["RSA_SOCKET", "RSA_WORKSPACE", "BASEWARE_SOCKET", "BASEWARE_EPOCH"]) delete env[key];
  try {
    for (const args of [["status"], ["controller", "list"], ["perception", "status"], ["action", "status"], ["run", "--device-only"]]) {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), "--workspace", workspace, ...args],
        { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, output }).toEqual({ code: 1, output: "" });
      if (args[0] === "run") expect(errors).toContain("rsa workspace import");
      expect(await readdir(workspace)).toEqual([]);
      expect(await readdir(directory)).toEqual(["bare"]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("creating a benchmark execution workspace cannot adopt unimported history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-legacy-guard-"));
  const workspace = join(directory, "old"), sessions = join(workspace, ".rsa", "shiori", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "old.jsonl"), "preserve old history");
  try {
    await expect(initializeWorkspaceState(workspace, join(directory, "home"))).rejects.toThrow("rsa workspace import");
    expect(await Bun.file(join(workspace, ".rsa", "workspace.json")).exists()).toBe(false);
    expect(await readFile(join(sessions, "old.jsonl"), "utf8")).toBe("preserve old history");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sessions, identity, versions and relative selection stay within each workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-state-"));
  try {
    const artifacts = join(directory, "artifacts");
    const first = await initializeWorkspaceState(join(directory, "workspaces", "one"), artifacts);
    const second = await initializeWorkspaceState(join(directory, "workspaces", "two"), artifacts);
    expect(first.dir).not.toBe(second.dir);
    expect(first.sessionsDir).not.toBe(second.sessionsDir);
    expect(first.versionsDir).not.toBe(second.versionsDir);
    expect(first.socket).not.toBe(second.socket);
    expect(first.sessionsDir).toBe(join(first.workspace, ".rsa", "shiori", "sessions"));
    expect(first.dir).toBe(join(first.workspace, ".rsa"));
    expect(first.versionsDir).toBe(join(first.dir, "skill-versions"));
    expect(await Bun.file(join(artifacts, "registry", `${first.id}.json`)).exists()).toBe(false);
    expect(await readCurrentSession(first)).toBeUndefined();
    expect(await readCurrentSession(second)).toBeUndefined();

    const firstSession = join(first.sessionsDir, "first.jsonl");
    const secondSession = join(second.sessionsDir, "second.jsonl");
    await writeCurrentSession(first, firstSession);
    await writeCurrentSession(second, secondSession);
    const reopened = await initializeWorkspaceState(first.workspace, artifacts);
    expect(reopened).toEqual(first);
    expect(await readCurrentSession(reopened)).toBe(firstSession);
    expect(await readCurrentSession(second)).toBe(secondSession);

    const replacement = join(first.sessionsDir, "new.jsonl");
    await writeCurrentSession(first, replacement);
    expect(await readCurrentSession(first)).toBe(replacement);
    expect(await readCurrentSession(second)).toBe(secondSession);
    expect(JSON.parse(await readFile(join(first.shioriDir, "current-session.json"), "utf8"))).toEqual({ version: 1, workspaceId: first.id, sessionFile: ".rsa/shiori/sessions/new.jsonl" });
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
    const first = await initializeWorkspaceState(original, join(directory, "state"));
    const second = await initializeWorkspaceState(alias, join(directory, "state"));
    expect(first.workspace).toBe(await realpath(original));
    expect(first.id).toMatch(/^ws-[a-f0-9-]{36}$/);
    expect(second).toEqual(first);
  } finally { await rm(directory, { recursive: true }); }
});

test("skill and memory snapshots travel inside the task workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-evidence-"));
  try {
    const state = await initializeWorkspaceState(join(directory, "tasks", "workspace"), join(directory, "state"));
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

test("moving keeps the relative selection and identity while escaped or foreign selections are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-relocation-"));
  try {
    const original = await initializeWorkspaceState(join(directory, "original"), join(directory, "home"));
    await writeCurrentSession(original, join(original.sessionsDir, "selected.jsonl"));
    await rename(original.workspace, join(directory, "moved"));
    const moved = await initializeWorkspaceState(join(directory, "moved"), join(directory, "other-home"));
    expect(moved.id).toBe(original.id);
    expect(moved.socket).not.toBe(original.socket);
    expect(await readCurrentSession(moved)).toBe(join(moved.sessionsDir, "selected.jsonl"));
    await expect(writeCurrentSession(moved, join(directory, "foreign.jsonl"))).rejects.toThrow("inside");
    const path = join(moved.shioriDir, "current-session.json");
    await writeFile(path, JSON.stringify({ version: 1, workspaceId: moved.id, sessionFile: "../foreign.jsonl" }));
    await expect(readCurrentSession(moved)).rejects.toThrow("inside");
    await writeFile(path, JSON.stringify({ version: 1, workspaceId: "another-workspace", sessionFile: ".rsa/shiori/sessions/selected.jsonl" }));
    await expect(readCurrentSession(moved)).rejects.toThrow("foreign");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
