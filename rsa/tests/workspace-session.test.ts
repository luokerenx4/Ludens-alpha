import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { migrateWorkspaceSessions, openWorkspaceSession, selectWorkspaceSession, validateSessionWorkspace } from "../src/harness/omp/workspace-session.ts";
import { readCurrentSession, resolveWorkspaceState } from "../src/harness/workspace-state.ts";

test("legacy sessions move with artifacts, retain history and old links, and resume at their canonical workspace path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-move-"));
  const state = await resolveWorkspaceState(join(directory, "workspace"), join(directory, "state"));
  const oldDir = join(state.dir, "sessions");
  const legacy = SessionManager.create(state.workspace, oldDir);
  legacy.appendMessage({ role: "user", content: "Keep the full original context.", timestamp: Date.now() });
  await legacy.ensureOnDisk();
  await legacy.close();
  const oldFile = legacy.getSessionFile()!;
  const file = join(state.sessionsDir, basename(oldFile));
  const bytes = await readFile(oldFile);
  const artifact = join(oldFile.replace(/\.jsonl$/, ""), "0.bash.log");
  await mkdir(oldFile.replace(/\.jsonl$/, ""), { recursive: true });
  await writeFile(artifact, "Full tool output");
  await writeFile(join(state.dir, "current-session.json"), JSON.stringify({ sessionFile: oldFile }));
  // A second historical session must move too, not just the selected transcript.
  await writeFile(join(oldDir, "older.jsonl"), bytes);
  let manager: SessionManager | undefined;
  try {
    await migrateWorkspaceSessions(state);
    expect(await readCurrentSession(state)).toBe(file);
    expect(await realpath(oldDir)).toBe(state.sessionsDir);
    expect(await readFile(file)).toEqual(bytes);
    expect(await readFile(join(state.sessionsDir, "older.jsonl"))).toEqual(bytes);
    expect(await readFile(artifact, "utf8")).toBe("Full tool output");
    expect(await Bun.file(join(state.dir, "current-session.json")).exists()).toBe(false);
    await migrateWorkspaceSessions(state);
    manager = await openWorkspaceSession(state, oldFile);
    expect(manager.getSessionFile()).toBe(file);
    expect(manager.getSessionId()).toBe(legacy.getSessionId());
    expect(manager.buildSessionContext().messages).toHaveLength(1);
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Keep the full original context.");
    await selectWorkspaceSession(state, manager);
    expect(await readCurrentSession(state)).toBe(file);
  } finally {
    await manager?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration refuses conflicting histories and recovers a move interrupted before writing its index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-move-recovery-"));
  const state = await resolveWorkspaceState(join(directory, "workspace"), join(directory, "state"));
  const oldDir = join(state.dir, "sessions");
  const oldFile = join(oldDir, "original.jsonl");
  const newFile = join(state.sessionsDir, "new.jsonl");
  const header = JSON.stringify({ type: "session", cwd: state.workspace }) + "\n";
  try {
    await mkdir(oldDir);
    await writeFile(oldFile, header);
    await writeFile(newFile, "Do not overwrite");
    await writeFile(join(state.dir, "current-session.json"), JSON.stringify({ sessionFile: oldFile }));
    await expect(migrateWorkspaceSessions(state)).rejects.toThrow("non-empty");
    expect(await readFile(oldFile, "utf8")).toBe(header);
    expect(await readFile(newFile, "utf8")).toBe("Do not overwrite");
    await rm(state.sessionsDir, { recursive: true });
    await writeFile(join(state.dir, ".sessions-migrating"), "");
    await rename(oldDir, state.sessionsDir); // Crash between rename and alias/index writes.
    await migrateWorkspaceSessions(state);
    expect(await realpath(oldFile)).toBe(join(state.sessionsDir, "original.jsonl"));
    expect(await readCurrentSession(state)).toBe(join(state.sessionsDir, "original.jsonl"));
    await migrateWorkspaceSessions(state);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stale selection does not block explicit recovery; an interrupted directory move needs no selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-move-stale-"));
  const state = await resolveWorkspaceState(join(directory, "workspace"), join(directory, "state"));
  const oldDir = join(state.dir, "sessions");
  let manager: SessionManager | undefined;
  try {
    await writeFile(join(state.sessionsDir, "tool-output.log"), "History without a current selection");
    await writeFile(join(state.dir, ".sessions-migrating"), "");
    await migrateWorkspaceSessions(state);
    expect(await readFile(join(oldDir, "tool-output.log"), "utf8")).toBe("History without a current selection");
    await writeFile(join(state.dir, "current-session.json"), JSON.stringify({ sessionFile: join(oldDir, "missing.jsonl") }));
    await migrateWorkspaceSessions(state);
    manager = await openWorkspaceSession(state); // --new-session bypasses the stale default.
    const fresh = await selectWorkspaceSession(state, manager);
    await writeFile(join(state.dir, "current-session.json"), JSON.stringify({ sessionFile: join(oldDir, "missing.jsonl") }));
    await migrateWorkspaceSessions(state);
    expect(await readCurrentSession(state)).toBe(fresh);
  } finally {
    await manager?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new workspace session survives idle shutdown, resumes, and can start fresh without deleting learned files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-session-"));
  const state = await resolveWorkspaceState(join(directory, "workspace"), join(directory, "state"));
  await mkdir(join(state.workspace, "skills"));
  await mkdir(join(state.workspace, "memory"));
  await writeFile(join(state.workspace, "skills", "learned.md"), "Keep this method.");
  await writeFile(join(state.workspace, "memory", "current.md"), "Keep this state.");
  const agentsPath = join(state.workspace, "AGENTS.md");
  await writeFile(agentsPath, "Workspace-local instructions: keep run records in logs/.\n");
  await writeFile(join(directory, "AGENTS.md"), "UNRELATED_PARENT_INSTRUCTIONS\n");
  const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false,
    "retry.enabled": false, "retry.modelFallback": false, "title.refreshOnReplan": false });
  const authStorage = await AuthStorage.create(join(directory, "auth.db"));
  authStorage.keys.setRuntime("openai-codex", "offline-test-only");
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const model = modelRegistry.find("openai-codex", "gpt-6.1-sol")!;
  let manager = await openWorkspaceSession(state);
  const create = async () => createOmpSession({
    cwd: state.workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
    sessionManager: manager, cacheWarming: false,
    skills: [], rules: [], contextFiles: await Bun.file(agentsPath).exists()
      ? [{ path: agentsPath, content: await readFile(agentsPath, "utf8") }] : [],
    promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    disableExtensionDiscovery: true, restrictToolNames: true, toolNames: [],
  });
  let { session } = await create();
  try {
    const systemPrompt = JSON.stringify(session.agent.state.systemPrompt);
    expect(systemPrompt).toContain("You are omp's trusted coding assistant.");
    expect(systemPrompt).toContain("Workspace-local instructions: keep run records in logs/.");
    expect(systemPrompt).not.toContain("UNRELATED_PARENT_INSTRUCTIONS");
    const emptyFile = await selectWorkspaceSession(state, manager);
    expect(await readCurrentSession(state)).toBe(emptyFile);
    await session.dispose();
    expect(await Bun.file(emptyFile).exists()).toBe(true);

    manager = await openWorkspaceSession(state, await readCurrentSession(state));
    expect(manager.getSessionFile()).toBe(emptyFile);
    expect(manager.buildSessionContext().messages).toHaveLength(0);
    ({ session } = await create());
    // Exercise the real SDK prompt/persistence path with an entirely offline transport.
    session.agent.streamFn = () => {
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [{ type: "text", text: "Workspace history survives restart." }], stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    await session.prompt("Remember this workspace.");
    await session.dispose();

    await rm(agentsPath);
    manager = await openWorkspaceSession(state, await readCurrentSession(state));
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Workspace history survives restart.");
    ({ session } = await create());
    const resumedPrompt = JSON.stringify(session.agent.state.systemPrompt);
    expect(resumedPrompt).toContain("You are omp's trusted coding assistant.");
    expect(resumedPrompt).not.toContain("Workspace-local instructions");
    expect(resumedPrompt).not.toContain("UNRELATED_PARENT_INSTRUCTIONS");
    expect(JSON.stringify(session.agent.state.messages)).toContain("Workspace history survives restart.");
    await session.dispose();
    manager = await openWorkspaceSession(state); // --new-session deliberately omits resume.
    expect(manager.buildSessionContext().messages).toHaveLength(0);
    const freshFile = await selectWorkspaceSession(state, manager);
    expect(freshFile).not.toBe(emptyFile);
    expect(await readCurrentSession(state)).toBe(freshFile);
    expect(await Bun.file(emptyFile).exists()).toBe(true);
    expect(await readFile(join(state.workspace, "skills", "learned.md"), "utf8")).toBe("Keep this method.");
    expect(await readFile(join(state.workspace, "memory", "current.md"), "utf8")).toBe("Keep this state.");
  } finally {
    await session.dispose();
    await manager.close();
    authStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("explicit old sessions stay in place; foreign workspace resumes are rejected before touching history or selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-owner-"));
  const first = await resolveWorkspaceState(join(directory, "first"), join(directory, "state"));
  const second = await resolveWorkspaceState(join(directory, "second"), join(directory, "state"));
  const legacy = SessionManager.create(first.workspace, join(directory, "old-runs"));
  legacy.appendMessage({ role: "user", content: "Existing workspace history.", timestamp: Date.now() });
  await legacy.ensureOnDisk();
  await legacy.close();
  const file = legacy.getSessionFile()!;
  const original = await readFile(file, "utf8");
  let selected = await openWorkspaceSession(second);
  try {
    const previous = await selectWorkspaceSession(second, selected);
    await selected.close();
    await expect(openWorkspaceSession(second, file)).rejects.toThrow("different workspace");
    expect(await readCurrentSession(second)).toBe(previous);
    expect(await readFile(file, "utf8")).toBe(original);

    const alias = join(directory, "first-alias");
    await symlink(first.workspace, alias);
    await validateSessionWorkspace(file, alias);
    selected = await openWorkspaceSession(first, file);
    expect(selected.getSessionFile()).toBe(await realpath(file));
    expect(selected.getSessionDir()).toBe(first.sessionsDir);
    await selectWorkspaceSession(first, selected);
    expect(await readCurrentSession(first)).toBe(await realpath(file));
    expect(await readCurrentSession(second)).toBe(previous);
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    await selected.close();
    await rm(directory, { recursive: true, force: true });
  }
});
