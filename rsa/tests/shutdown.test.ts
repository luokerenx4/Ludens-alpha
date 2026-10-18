import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { send } from "../src/harness/transport.ts";
import { resolveWorkspaceState } from "../src/harness/workspace-state.ts";

test("SIGTERM waits for runtime cleanup before recording run_end with OMP's real signal handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-shutdown-"));
  const state = await resolveWorkspaceState(join(directory, "workspace"), resolve(import.meta.dir, "../../../artifacts/rsa"));
  const socketPath = join(directory, "host.sock");
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
  const preload = join(directory, "driver.ts");
  // Mock only the model driver. main.ts imports the real postmortem module, and
  // the real runtime owns a TCP provider whose DISOWN must finish on shutdown.
  await writeFile(preload, `import { mock } from "bun:test";
mock.module(${JSON.stringify(resolve(import.meta.dir, "../src/harness/omp/session.ts"))}, () => ({
  createOmpDriver: async ({ log }) => ({
    run: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })),
    consolidate: async () => {},
    abort: async () => {},
    close: async () => {
      log.record("test_driver_close_start", {});
      await Bun.sleep(100);
      log.record("test_driver_close_end", {});
    },
  }),
}));
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, resolve(import.meta.dir, "../src/app/main.ts"),
    "run", "--port", String((bridge.address() as AddressInfo).port), "--workspace", join(directory, "workspace")], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, RSA_SOCKET: socketPath, PI_CODING_AGENT_DIR: join(directory, "omp") },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.trimEnd().endsWith("}")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Host exited before ready: ${await stderr}`);
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const ready = JSON.parse(output);
    await send(socketPath, { kind: "auto", argv: ["on"], runId: ready.runId, expectedEpoch: null });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143); // OMP's documented signal exit code.
    expect(await stderr).toBe("");
    const events = (await readFile(join(ready.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(operations).toEqual(["HELLO", "OWN", "DISOWN"]);
    const started = events.filter(event => event.type === "test_driver_close_start");
    const completed = events.filter(event => event.type === "test_driver_close_end");
    const ended = events.filter(event => event.type === "run_end");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(completed[0].atMs - started[0].atMs).toBeGreaterThanOrEqual(90);
    expect(ended[0].seq).toBeGreaterThan(completed[0].seq);
    expect(ended[0].data).toMatchObject({ mode: "manual", thinking: false });
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    await rm(state.dir, { recursive: true, force: true });
  }
}, 10_000);
