import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, copyFile, appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { importLegacyWorkspaceState, openWorkspaceSession, selectWorkspaceSession, validateSessionWorkspace } from "../src/harness/omp/workspace-session.ts";
import { readCurrentSession, initializeWorkspaceState } from "../src/harness/workspace-state.ts";

test("explicit legacy import copies history, tool output and skill versions without retaining source dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-import-"));
  const home = join(directory, "home"), state = await initializeWorkspaceState(join(directory, "workspace"), home);
  const source = join(directory, "legacy"), oldDir = join(source, "sessions");
  const legacy = SessionManager.create(state.workspace, oldDir);
  legacy.appendMessage({ role: "user", content: "Keep the full original context.", timestamp: Date.now() });
  await legacy.ensureOnDisk(); await legacy.close();
  const oldFile = legacy.getSessionFile()!, original = await readFile(oldFile);
  const artifact = oldFile.replace(/\.jsonl$/, "");
  await mkdir(artifact); await writeFile(join(artifact, "0.bash.log"), "Full tool output");
  await mkdir(join(source, "skill-versions")); await writeFile(join(source, "skill-versions", "revision.json"), "snapshot");
  await writeFile(join(source, "workspace.json"), JSON.stringify({ workspace: state.workspace }));
  await writeFile(join(source, "current-session.json"), JSON.stringify({ sessionFile: oldFile }));
  let manager: SessionManager | undefined;
  try {
    await expect(openWorkspaceSession(state, oldFile)).rejects.toThrow("explicit workspace import");
    const result = await importLegacyWorkspaceState(state.workspace, { legacyStateDir: source, globalHome: home });
    const file = join(state.sessionsDir, basename(oldFile));
    expect(await readCurrentSession(state)).toBe(file);
    expect(await readFile(oldFile)).toEqual(original);
    expect(await readFile(join(state.sessionsDir, basename(artifact), "0.bash.log"), "utf8")).toBe("Full tool output");
    expect(await readFile(join(state.versionsDir, "revision.json"), "utf8")).toBe("snapshot");
    expect(await importLegacyWorkspaceState(state.workspace, { legacyStateDir: source, globalHome: home })).toEqual(result);
    await rm(source, { recursive: true });
    manager = await openWorkspaceSession(state, file);
    expect(manager.getSessionId()).toBe(legacy.getSessionId());
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Keep the full original context.");
    expect(await readFile(file, "utf8")).toContain(state.id);
  } finally { await manager?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy import rejects conflicts and foreign source ownership before copying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-conflict-"));
  const home = join(directory, "home"), state = await initializeWorkspaceState(join(directory, "workspace"), home);
  const source = join(directory, "legacy");
  const legacy = SessionManager.create(state.workspace, join(source, "sessions"));
  await legacy.ensureOnDisk(); await legacy.close();
  await writeFile(join(source, "workspace.json"), JSON.stringify({ workspace: state.workspace }));
  const target = join(state.sessionsDir, basename(legacy.getSessionFile()!));
  try {
    await writeFile(target, "Do not overwrite");
    await expect(importLegacyWorkspaceState(state.workspace, { legacyStateDir: source, globalHome: home })).rejects.toThrow("Conflicting");
    expect(await readFile(target, "utf8")).toBe("Do not overwrite");
    await rm(target);
    await writeFile(join(source, "workspace.json"), JSON.stringify({ workspace: join(directory, "foreign") }));
    await expect(importLegacyWorkspaceState(state.workspace, { legacyStateDir: source, globalHome: home })).rejects.toThrow("different workspace");
    expect(await Bun.file(target).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a moved legacy workspace needs explicit previous ownership before adopting its absolute selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-session-relocate-"));
  const home = join(directory, "home"), old = await initializeWorkspaceState(join(directory, "old"), home);
  const manager = SessionManager.create(old.workspace, old.sessionsDir);
  manager.appendMessage({ role: "user", content: "Legacy context", timestamp: Date.now() });
  await manager.ensureOnDisk(); await manager.close();
  const oldFile = manager.getSessionFile()!;
  await writeFile(join(old.shioriDir, "current-session.json"), JSON.stringify({ sessionFile: oldFile }));
  await rename(old.workspace, join(directory, "moved"));
  const moved = await initializeWorkspaceState(join(directory, "moved"), home);
  try {
    await expect(readCurrentSession(moved)).rejects.toThrow("Legacy");
    await expect(importLegacyWorkspaceState(moved.workspace, { globalHome: home })).rejects.toThrow("different workspace");
    await importLegacyWorkspaceState(moved.workspace, { previousWorkspace: old.workspace, globalHome: home });
    expect(moved.id).toBe(old.id);
    const file = await readCurrentSession(moved);
    expect(file).toBe(join(moved.sessionsDir, basename(oldFile)));
    const resumed = await openWorkspaceSession(moved, file);
    expect(resumed.getCwd()).toBe(moved.workspace);
    expect(JSON.stringify(resumed.buildSessionContext().messages)).toContain("Legacy context");
    await resumed.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a new workspace session survives idle shutdown, resumes, and can start fresh without deleting learned files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-session-"));
  const state = await initializeWorkspaceState(join(directory, "workspace"), join(directory, "state"));
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

test("moving preserves identity and context; same-named foreign sessions and renewed identities stay isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-owner-"));
  const home = join(directory, "home"), first = await initializeWorkspaceState(join(directory, "first"), home);
  let manager = await openWorkspaceSession(first);
  manager.appendMessage({ role: "user", content: "Stable workspace context", timestamp: Date.now() });
  const file = await selectWorkspaceSession(first, manager), sessionId = manager.getSessionId();
  await manager.close();
  await rename(first.workspace, join(directory, "moved"));
  const moved = await initializeWorkspaceState(join(directory, "moved"), home);
  const second = await initializeWorkspaceState(join(directory, "second"), home);
  try {
    expect(moved.id).toBe(first.id); expect(moved.socket).not.toBe(first.socket);
    const selected = (await readCurrentSession(moved))!;
    await appendFile(selected, '{"type":'); // Interrupted append: ownership is already durably recorded.
    manager = await openWorkspaceSession(moved, selected);
    expect(manager.getSessionId()).toBe(sessionId);
    expect(manager.getCwd()).toBe(moved.workspace);
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Stable workspace context");
    await manager.close();
    const copied = join(second.sessionsDir, basename(file));
    await copyFile(selected, copied);
    await expect(openWorkspaceSession(second, copied)).rejects.toThrow("different workspace");
    expect(await readCurrentSession(second)).toBeUndefined();
    const alias = join(directory, "alias"); await symlink(moved.workspace, alias);
    await validateSessionWorkspace(selected, alias);
    const { renewWorkspaceIdentity } = await import("../../shared/ludens.ts");
    await renewWorkspaceIdentity(moved.workspace, home);
    const renewed = await initializeWorkspaceState(moved.workspace, home);
    expect(await readCurrentSession(renewed)).toBeUndefined();
    await expect(openWorkspaceSession(renewed, selected)).rejects.toThrow("different workspace");
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
