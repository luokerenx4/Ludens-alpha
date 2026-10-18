import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createOmpSession } from "../src/harness/omp/session.ts";
import { openWorkspaceSession, selectWorkspaceSession, validateSessionWorkspace } from "../src/harness/omp/workspace-session.ts";
import { readCurrentSession, resolveWorkspaceState } from "../src/harness/workspace-state.ts";

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
  const create = () => createOmpSession({
    cwd: state.workspace, agentDir: join(directory, "omp"), model, authStorage, modelRegistry, settings,
    sessionManager: manager, customSystemPrompt: "Offline workspace lifecycle test.", cacheWarming: false,
    skills: [], rules: [], contextFiles: [{ path: agentsPath, content: "Workspace-local instructions: keep run records in logs/.\n" }],
    promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    disableExtensionDiscovery: true, restrictToolNames: true, toolNames: [],
  });
  let { session } = await create();
  try {
    const systemPrompt = JSON.stringify(session.agent.state.systemPrompt);
    expect(systemPrompt).toContain("Offline workspace lifecycle test.");
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

    manager = await openWorkspaceSession(state, await readCurrentSession(state));
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Workspace history survives restart.");
    await manager.close();
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
    expect(selected.getSessionFile()).toBe(file);
    expect(selected.getSessionDir()).toBe(first.sessionsDir);
    await selectWorkspaceSession(first, selected);
    expect(await readCurrentSession(first)).toBe(file);
    expect(await readCurrentSession(second)).toBe(previous);
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    await selected.close();
    await rm(directory, { recursive: true, force: true });
  }
});
