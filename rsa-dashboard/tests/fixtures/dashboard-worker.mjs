import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
const pending = new Map();
let cancelled = 0;
parentPort.on("message", message => {
  if (message.type === "close") { for (const timer of pending.values()) clearTimeout(timer); parentPort.close(); return; }
  if (message.type === "cancel") {
    if (pending.has(message.id)) { clearTimeout(pending.get(message.id)); pending.delete(message.id); cancelled++; }
    return;
  }
  const reply = value => parentPort.postMessage({ type: "result", id: message.id, value });
  if (message.method === "catalog") { reply([]); return; }
  if (message.method === "petState") { reply({ cancelled }); return; }
  const input = message.args[0];
  if (input.crash) { appendFileSync(process.env.WORKER_MUTATIONS, "mutation\n"); process.exit(13); }
  if (input.error) {
    parentPort.postMessage({ type: "error", id: message.id, error: { name: "PreparingArchive", message: "preparing", status: 202, code: "ARCHIVE_PREPARING", progress: { read: 100, total: 1000 } } });
    return;
  }
  pending.set(message.id, setTimeout(() => { pending.delete(message.id); reply(input.value); }, input.delay ?? 0));
});
parentPort.postMessage({ type: "ready" });
