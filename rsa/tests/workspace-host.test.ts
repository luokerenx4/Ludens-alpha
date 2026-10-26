import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { send } from "../src/harness/transport.ts";
import { resolveWorkspaceState, writeCurrentSession, type WorkspaceState } from "../src/harness/workspace-state.ts";

const rsaDirectory = resolve(import.meta.dir, "..");
const entry = join(rsaDirectory, "src/app/main.ts");
const artifactRoot = resolve(rsaDirectory, "../../artifacts/rsa");
type Ready = { ready: true; runId: string; runDir: string; stateDir: string; workspace: string; socket: string };
type Host = { child: Bun.Subprocess<"ignore", "pipe", "pipe">; stderr: Promise<string> };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rsa-workspace-host-"));
  const operations: string[] = [];
  const sockets = new Set<Socket>();
  const states: WorkspaceState[] = [];
  const children: Host[] = [];
  const basewareSockets = new Map<string, string>();
  const bridge = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const [id, operation] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        operations.push(operation);
        socket.write(`${id}\tOK${operation === "HELLO" ? "\t16777216\t280896" : ""}\n`);
      }
    });
  });
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const preload = join(directory, "driver.ts");
  await writeFile(preload, `import { mock } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
mock.module(${JSON.stringify(join(rsaDirectory, "src/harness/omp/session.ts"))}, () => ({
  createOmpAgent: async ({ workspace, resume, runDir }) => {
    // The interface snapshot is available before the agent starts.
    await readFile(join(workspace, "baseware.json"), "utf8");
    await writeFile(join(runDir, "test-driver.json"), JSON.stringify({ workspace, resume, cwd: process.cwd() }));
    await appendFile(process.env.RSA_TEST_DRIVER_CALLS, JSON.stringify({ workspace, resume }) + "\\n");
    if (process.env.RSA_TEST_GATE) {
      while (!await Bun.file(process.env.RSA_TEST_GATE).exists()) await Bun.sleep(10);
    }
    return { run: async () => {}, consolidate: async () => {}, abort: async () => {}, close: async () => {} };
  },
}));
`);
  const driverCalls = join(directory, "driver-calls.jsonl");
  function environment(extra: Record<string, string> = {}) {
    const env = { ...process.env };
    delete env.RSA_SOCKET;
    delete env.RSA_WORKSPACE;
    delete env.BASEWARE_SOCKET;
    delete env.BASEWARE_EPOCH;
    delete env.BASEWARE_TRACE;
    return { ...env, PI_CODING_AGENT_DIR: join(directory, "omp"), RSA_TEST_DRIVER_CALLS: driverCalls, ...extra };
  }
  function launch(workspace: string, options: string[] = [], extra: Record<string, string> = {}, fromCwd = false): Host {
    const child = Bun.spawn([process.execPath, "--preload", preload, entry, "run", ...(fromCwd ? [] : ["--workspace", workspace]),
      "--baseware-socket", basewareSockets.get(workspace)!, ...options], {
      cwd: fromCwd ? workspace : rsaDirectory, env: environment(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const launched = { child, stderr: new Response(child.stderr).text() };
    children.push(launched);
    return launched;
  }
  return { directory, operations, driverCalls, launch,
    async state(name: string) {
      const state = await resolveWorkspaceState(join(directory, "workspaces", name), artifactRoot);
      states.push(state);
      const socket = join(directory, `baseware-${name}.sock`);
      basewareSockets.set(state.workspace, socket);
      const child = Bun.spawn([process.execPath, join(rsaDirectory, "../baseware/src/main.ts"), "serve",
        "--driver", "mgba", "--port", String((bridge.address() as AddressInfo).port),
        "--socket", socket, "--data-dir", join(state.workspace, "logs/baseware")], {
        cwd: state.workspace, env: environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const service = { child, stderr: new Response(child.stderr).text() };
      children.push(service);
      await ready(service);
      return state;
    },
    async status(workspace: string, fromCwd = false) {
      const cli = Bun.spawn([process.execPath, entry, ...(fromCwd ? [] : ["--workspace", workspace]), "status"], {
        cwd: fromCwd ? workspace : rsaDirectory, env: environment(), stdout: "pipe", stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      return JSON.parse(output);
    },
    async close() {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(({ child }) => child.exited));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => bridge.close(() => resolve()));
      for (const state of states) {
        await rm(state.dir, { recursive: true, force: true });
        await rm(state.socket, { force: true });
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function ready(host: Host): Promise<Ready> {
  const reader = host.child.stdout.getReader();
  let output = "";
  try {
    while (!output.trimEnd().endsWith("}")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Host exited before ready: ${await host.stderr}`);
      output += new TextDecoder().decode(chunk.value);
    }
    return JSON.parse(output);
  } finally { reader.releaseLock(); }
}

test("hosts route by workspace, resume only its selected session, and can start fresh without deleting task files", async () => {
  const testbed = await fixture();
  try {
    const first = await testbed.state("one");
    const second = await testbed.state("two");
    for (const state of [first, second]) {
      const sessionFile = join(state.sessionsDir, "selected.jsonl");
      await writeFile(sessionFile, JSON.stringify({ type: "session", cwd: state.workspace }) + "\n");
      await writeCurrentSession(state, sessionFile);
    }
    await writeFile(join(first.workspace, "notes.txt"), "Keep this learned material.\n");
    await writeFile(join(first.workspace, "AGENTS.md"), "Keep these task instructions.\n");
    await writeFile(join(first.workspace, "baseware.json"), JSON.stringify({ stale: true }));
    const firstHost = testbed.launch(first.workspace, ["--seconds", "111"], {}, true);
    const secondHost = testbed.launch(second.workspace, ["--seconds", "222"]);
    const [one, two] = await Promise.all([ready(firstHost), ready(secondHost)]);
    expect(one.socket).toBe(first.socket);
    expect(two.socket).toBe(second.socket);
    expect(one.socket).not.toBe(two.socket);
    for (const [state, result] of [[first, one], [second, two]] as const) {
      expect(result.stateDir).toBe(state.dir);
      expect(result.runDir).toBe(join(state.workspace, "logs", result.runId));
      expect(JSON.parse(await readFile(join(state.dir, "workspace.json"), "utf8"))).toEqual({ workspace: state.workspace });
      expect(await Bun.file(join(result.runDir, "events.jsonl")).exists()).toBe(true);
      const manifest = JSON.parse(await readFile(join(result.runDir, "manifest.json"), "utf8"));
      expect(manifest.provenance.workspaceInstructionsSHA256).toBe(state === first
        ? new Bun.SHA256().update("Keep these task instructions.\n").digest("hex") : null);
      const catalog = JSON.parse(await readFile(join(state.workspace, "baseware.json"), "utf8"));
      expect(catalog.schemaVersion).toBe(2);
      expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
      expect(catalog.controllers.map((item: { name: string }) => item.name)).toContain("pad.play");
      expect(catalog.stale).toBeUndefined();
      expect(JSON.parse(await readFile(join(result.runDir, "test-driver.json"), "utf8"))).toEqual({
        workspace: state.workspace, resume: join(state.sessionsDir, "selected.jsonl"), cwd: state.workspace,
      });
      expect(await testbed.status(state.workspace, state === first)).toMatchObject({ runId: result.runId, mode: "manual",
        maxSeconds: state === first ? 111 : 222 });
    }
    const firstGuide = await readFile(join(first.workspace, "AGENTS.md"), "utf8");
    expect(firstGuide).toBe("Keep these task instructions.\n");
    expect(await Bun.file(join(second.workspace, "AGENTS.md")).exists()).toBe(false);
    expect(await readFile(join(second.workspace, "perception.py"), "utf8")).toContain("raise NotImplementedError");
    expect(testbed.operations).toEqual(["HELLO", "HELLO"]);
    const secondCatalog = await readFile(join(second.workspace, "baseware.json"), "utf8");
    firstHost.child.kill("SIGTERM");
    expect(await firstHost.child.exited).toBe(143);
    await writeFile(join(first.workspace, "baseware.json"), JSON.stringify({ stale: true }));
    const fresh = await ready(testbed.launch(first.workspace, ["--new-session"]));
    expect(await readFile(join(first.workspace, "AGENTS.md"), "utf8")).toBe(firstGuide);
    expect(JSON.parse(await readFile(join(first.workspace, "baseware.json"), "utf8")).stale).toBeUndefined();
    expect(await readFile(join(second.workspace, "baseware.json"), "utf8")).toBe(secondCatalog);
    expect(testbed.operations).toEqual(["HELLO", "HELLO"]);
    expect(JSON.parse(await readFile(join(fresh.runDir, "test-driver.json"), "utf8"))).toEqual({ workspace: first.workspace, cwd: first.workspace });
    expect(await readFile(join(first.workspace, "notes.txt"), "utf8")).toBe("Keep this learned material.\n");
    expect(await testbed.status(second.workspace)).toMatchObject({ runId: two.runId, mode: "manual" });
  } finally { await testbed.close(); }
}, 15_000);

test("a starting host owns the workspace before readiness even when another address is requested", async () => {
  const testbed = await fixture();
  try {
    const state = await testbed.state("starting");
    const gate = join(testbed.directory, "continue-initialization");
    const firstAlias = join(testbed.directory, "first.sock");
    const secondAlias = join(testbed.directory, "second.sock");
    const firstHost = testbed.launch(state.workspace, [], { RSA_SOCKET: firstAlias, RSA_TEST_GATE: gate });
    const deadline = Date.now() + 5000;
    while (!await Bun.file(testbed.driverCalls).exists()) {
      if (Date.now() > deadline) throw new Error("Host never entered the mock driver initialization");
      await Bun.sleep(10);
    }
    await expect(send(state.socket, { kind: "status", argv: [] })).rejects.toThrow("Host is starting or closing");
    await expect(send(firstAlias, { kind: "status", argv: [] })).rejects.toThrow("Host is starting or closing");
    const legacyDir = join(state.dir, "sessions");
    await mkdir(legacyDir);
    await writeFile(join(legacyDir, "still-owned.jsonl"), "Do not move a live host's files");
    const duplicate = testbed.launch(state.workspace, [], { RSA_SOCKET: secondAlias });
    expect(await duplicate.child.exited).toBe(1);
    expect(await duplicate.stderr).toContain("Host already running");
    expect(testbed.operations).toEqual(["HELLO"]);
    expect((await readFile(testbed.driverCalls, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await Bun.file(secondAlias).exists()).toBe(false);
    expect((await lstat(legacyDir)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(legacyDir, "still-owned.jsonl"), "utf8")).toBe("Do not move a live host's files");
    await writeFile(gate, "continue");
    const result = await ready(firstHost);
    expect(result.socket).toBe(firstAlias);
    expect(await testbed.status(state.workspace)).toMatchObject({ runId: result.runId, mode: "manual" });
  } finally { await testbed.close(); }
}, 15_000);
