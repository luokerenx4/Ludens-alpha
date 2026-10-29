import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BasewareClient } from "@ludens/baseware/client";
import { readRunEvents } from "../../shared/event-sources.ts";
import { send } from "../src/harness/transport.ts";
import { initializeWorkspaceState } from "../src/harness/workspace-state.ts";

test("SIGTERM waits for runtime cleanup before recording run_end with OMP's real signal handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-shutdown-"));
  const state = await initializeWorkspaceState(join(directory, "workspace"), join(directory, "global"));
  const socketPath = join(directory, "host.sock");
  const basewareSocket = join(directory, "baseware.sock");
  const operations: string[] = [];
  const sockets = new Set<Socket>();
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
  const preload = join(directory, "agent.ts");
  // Mock only the agent. The real OMP signal handler shuts down the RSA host,
  // which must release its lease through an independently running Baseware.
  await writeFile(preload, `import { mock } from "bun:test";
mock.module(${JSON.stringify(resolve(import.meta.dir, "../src/harness/omp/session.ts"))}, () => ({
  createOmpAgent: async ({ log }) => ({
    run: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })),
    consolidate: async () => {},
    abort: async () => {},
    close: async () => {
      log.record("test_agent_close_start", {});
      await Bun.sleep(100);
      log.record("test_agent_close_end", {});
    },
  }),
}));
`);
  const service = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../baseware/src/main.ts"), "serve",
    "--driver", "lease-fixture", "--driver-package", `file:${resolve(import.meta.dir, "../../baseware/tests/fixtures/lease-driver.ts")}`, "--port", String((bridge.address() as AddressInfo).port),
    "--socket", basewareSocket, "--data-dir", join(directory, "device-records")], {
    cwd: directory, stdout: "pipe", stderr: "pipe",
  });
  const serviceStderr = new Response(service.stderr).text();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  async function readReady(stdout: ReadableStream<Uint8Array>, stderr: Promise<string>) {
    const reader = stdout.getReader();
    let output = "";
    try {
      while (!output.trimEnd().endsWith("}")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Process exited before ready: ${await stderr}`);
        output += new TextDecoder().decode(chunk.value);
      }
      return JSON.parse(output);
    } finally { reader.releaseLock(); }
  }
  try {
    expect(await readReady(service.stdout, serviceStderr)).toMatchObject({ ready: true, mode: "manual" });
    const host = Bun.spawn([process.execPath, "--preload", preload, resolve(import.meta.dir, "../src/app/main.ts"),
      "run", "--baseware-socket", basewareSocket, "--workspace", join(directory, "workspace")], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, LUDENS_HOME: state.globalHome, RSA_SOCKET: socketPath, PI_CODING_AGENT_DIR: join(directory, "omp") },
      stdout: "pipe", stderr: "pipe",
    });
    child = host;
    const stderr = new Response(host.stderr).text();
    const ready = await readReady(host.stdout, stderr);
    await send(socketPath, { kind: "auto", argv: ["on"], runId: ready.runId, expectedEpoch: null });
    host.kill("SIGTERM");
    expect(await host.exited).toBe(143); // OMP's documented signal exit code.
    expect(await stderr).toBe("");
    const events = [];
    for await (const event of readRunEvents(ready.runDir)) events.push(event);
    expect(operations).toEqual(["HELLO", "OWN", "DISOWN"]);
    const started = events.filter(event => event.type === "test_agent_close_start");
    const completed = events.filter(event => event.type === "test_agent_close_end");
    const ended = events.filter(event => event.type === "run_end");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(completed[0].atMs - started[0].atMs).toBeGreaterThanOrEqual(90);
    expect(ended[0].seq).toBeGreaterThan(completed[0].seq);
    expect(ended[0].data).toMatchObject({ mode: "manual", thinking: false });
    const handback = events.find(event => event.type === "baseware_control" && event.data.mode === "manual");
    expect(handback).toBeDefined();
    // Cross-process wall times may tie within a millisecond; source seq is local.
    expect(Date.parse(handback!.at)).toBeLessThanOrEqual(Date.parse(started[0]!.at));
    expect(service.exitCode).toBeNull();
    const inspector = await BasewareClient.connect(basewareSocket);
    try { expect(await inspector.request({ kind: "status" })).toMatchObject({ mode: "manual", connected: true }); }
    finally { inspector.close(); }
    service.kill("SIGTERM");
    expect(await service.exited).toBe(0);
    expect(await serviceStderr).toBe("");
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    if (service.exitCode === null) { service.kill("SIGKILL"); await service.exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    await rm(state.dir, { recursive: true, force: true });
    await rm(state.socket, { force: true });
  }
}, 10_000);
