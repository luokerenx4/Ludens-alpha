import { createServer, connect, type Socket } from "node:net";
import { lstat, unlink } from "node:fs/promises";
import type { BasewareCore, ClientContext } from "./core.ts";
import type { Envelope, Message, Response } from "./protocol.ts";

export async function listen(path: string, source: BasewareCore | (() => BasewareCore)) {
  const getCore = () => typeof source === "function" ? source() : source;
  try {
    if (!(await lstat(path)).isSocket()) throw new Error(`Not a Unix socket: ${path}`);
    await new Promise<void>((resolve, reject) => {
      const probe = connect(path);
      probe.once("connect", () => { probe.destroy(); reject(new Error(`Baseware already running: ${path}`)); });
      probe.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "ECONNREFUSED") resolve(); else reject(error); });
    });
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    const pending = new Map<string, AbortController>();
    const send = (message: Message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
    const client: ClientContext = { id: crypto.randomUUID(), onEvent: event => send({ event }) };
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      for (const control of pending.values()) control.abort();
      pending.clear();
      try { void getCore().disconnectClient(client.id); } catch { /* Startup failed before a core existed. */ }
    });
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let envelope: Envelope;
        try {
          envelope = JSON.parse(line);
          if (!envelope || typeof envelope.id !== "string" || !envelope.request || typeof envelope.request.kind !== "string") throw new Error("Expected {id, request}");
        } catch (error) { send({ id: "", ok: false, error: String(error) }); continue; }
        const { id, request } = envelope;
        if (request.kind === "cancel") {
          const control = pending.get(request.operationId ?? "");
          control?.abort();
          send({ id, ok: true, value: { cancelled: !!control } });
          continue;
        }
        if (pending.has(id)) { send({ id, ok: false, error: "Duplicate request ID" }); continue; }
        const control = new AbortController();
        pending.set(id, control);
        void (async () => {
          let response: Response;
          try { response = { id, ok: true, value: await getCore().handle(request, client, control.signal) }; }
          catch (error) { response = { id, ok: false, error: String(error) }; }
          finally { pending.delete(id); }
          send(response);
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return async () => {
    let core: BasewareCore | undefined;
    try { core = getCore(); } catch { /* Startup failed before a core existed. */ }
    await core?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
  };
}
