import { createServer, connect } from "node:net";
import { lstat, unlink } from "node:fs/promises";
import type { Runtime } from "./runtime.ts";

export interface Request { kind: string; argv: string[]; epoch?: string; runId?: string; expectedEpoch?: string | null }
type Response = { ok: true; value: unknown } | { ok: false; error: string };

export async function listen(path: string, runtime: Runtime | (() => Runtime)) {
  // A killed host can leave a Unix socket behind. Never remove a live host's socket.
  try {
    if (!(await lstat(path)).isSocket()) throw new Error(`Not a Unix socket: ${path}`);
    await new Promise<void>((resolve, reject) => {
      const probe = connect(path);
      probe.once("connect", () => { probe.destroy(); reject(new Error(`Host already running: ${path}`)); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve(); else reject(error);
      });
    });
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createServer((socket) => {
    let buffer = "";
    let dispatched = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {}); // A CLI can disappear while management cleanup finishes.
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0 || dispatched) return;
      dispatched = true;
      void (async () => {
        let response: Response;
        try {
          const request: Request = JSON.parse(buffer.slice(0, end));
          response = { ok: true, value: await dispatch(typeof runtime === "function" ? runtime() : runtime, request) };
        } catch (error) { response = { ok: false, error: String(error) }; }
        socket.end(JSON.stringify(response) + "\n");
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function dispatch(runtime: Runtime, request: Request): Promise<unknown> {
  const { kind, argv, epoch } = request;
  if (kind === "status") return runtime.status();
  if (kind === "auto" || kind === "consolidate") {
    if (epoch !== undefined) throw new Error("Control management belongs to the human, not an agent cycle");
    const status = runtime.status();
    if (request.runId !== status.runId) throw new Error("STALE_RUN: refresh the host status before changing control");
    if (request.expectedEpoch !== undefined && request.expectedEpoch !== status.epoch) throw new Error("STALE_EPOCH: the control cycle changed");
    if (kind === "consolidate") {
      if (argv.length === 0) return runtime.consolidate();
      if (argv.length === 2 && argv[0] === "--seconds") return runtime.consolidate(Number(argv[1]));
      throw new Error("Usage: rsa consolidate [--seconds <n>]");
    }
    if (argv.length === 1 && argv[0] === "on") return runtime.start();
    if (argv.length === 3 && argv[0] === "on" && argv[1] === "--message" && argv[2]?.trim()) return runtime.start(argv[2]);
    if (argv.length === 1 && argv[0] === "off") { await runtime.stop(); return runtime.status(); }
    throw new Error("Usage: rsa auto on [--message <text>] | rsa auto off");
  }
  throw new Error("Unknown command; see rsa --help");
}

export function send(path: string, request: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let complete = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.on("close", () => { if (!complete) reject(new Error("Host disconnected before replying")); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0 || complete) return;
      complete = true;
      socket.end();
      try {
        const response: Response = JSON.parse(buffer.slice(0, end));
        if (response.ok) resolve(response.value);
        else reject(new Error(response.error));
      } catch (error) { reject(error); }
    });
  });
}
