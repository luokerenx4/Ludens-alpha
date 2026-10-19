import { connect, type Socket } from "node:net";
import type { DeviceEvent, Message, Request } from "./protocol.ts";
export type { DeviceEvent, Request, Trace } from "./protocol.ts";

export class BasewareClient {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private failure?: Error;
  private buffer = "";

  private constructor(private socket: Socket, private options: {
    onEvent?(event: DeviceEvent): void; onDisconnect?(error: Error): void;
  }) {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const message: Message = JSON.parse(line);
          if ("event" in message) { this.options.onEvent?.(message.event); continue; }
          const task = this.pending.get(message.id);
          if (!task) continue;
          this.pending.delete(message.id);
          task.cleanup();
          if (message.ok) task.resolve(message.value);
          else task.reject(new Error(message.error));
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    socket.on("error", error => this.fail(error));
    socket.on("close", () => this.fail(new Error("Baseware disconnected")));
  }

  static async connect(path: string, options: { onEvent?(event: DeviceEvent): void; onDisconnect?(error: Error): void } = {}) {
    const socket = connect(path);
    const client = new BasewareClient(socket, options);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    if (options.onEvent) await client.request({ kind: "subscribe" });
    return client;
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const task of this.pending.values()) { task.cleanup(); task.reject(error); }
    this.pending.clear();
    this.socket.destroy();
    this.options.onDisconnect?.(error);
  }

  request(request: Request, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        this.socket.write(JSON.stringify({ id: crypto.randomUUID(), request: { kind: "cancel", operationId: id } }) + "\n");
        reject(signal?.reason ?? new Error("Request aborted"));
      };
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) });
      signal?.addEventListener("abort", cancel, { once: true });
      this.socket.write(JSON.stringify({ id, request }) + "\n");
    });
  }

  close() { this.socket.destroy(); }
}
