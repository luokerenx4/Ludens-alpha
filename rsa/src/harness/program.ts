import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { RecordEvent } from "./events.ts";

/** A local execution mode of Shiori. No trial, score, lease or budget ownership lives here. */
export interface Program {
  argv: string[]; cwd: string; env: NodeJS.ProcessEnv;
  stdout: string; stderr: string;
  /** Internal fixture programs forward their facts to the owning Shiori EventLog. */
  events?: boolean;
}
export async function executeProgram(program: Program, signal: AbortSignal, record: RecordEvent): Promise<void> {
  signal.throwIfAborted();
  if (!program.argv.length || program.argv.some(value => typeof value !== "string" || !value)) throw new Error("Program argv must contain nonempty strings");
  const stdout = createWriteStream(program.stdout), stderr = createWriteStream(program.stderr);
  const writes = Promise.all([finished(stdout), finished(stderr)]);
  void writes.catch(() => {});
  const child = spawn(program.argv[0]!, program.argv.slice(1), { cwd: program.cwd, env: program.env, detached: true,
    stdio: program.events ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(stdout); child.stderr!.pipe(stderr);
  let forced: ReturnType<typeof setTimeout> | undefined;
  let outputError: Error | undefined;
  const kill = (name: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const abort = () => { kill("SIGTERM"); forced ??= setTimeout(() => kill("SIGKILL"), 2000); };
  stdout.on("error", error => { outputError = error; abort(); });
  stderr.on("error", error => { outputError = error; abort(); });
  child.on("message", (message: any) => {
    try {
      if (program.events && message?.kind === "event" && typeof message.type === "string") record(message.type, message.data, message.trace, message.metadata);
      if (program.events && message?.kind === "flush") child.send({ kind: "flushed", id: message.id });
    } catch (error) { outputError = error instanceof Error ? error : new Error(String(error)); abort(); }
  });
  // Descendants may inherit stdout/stderr. Kill them when the command exits,
  // before waiting for close/drain, or a background child can hold the pipes forever.
  child.once("exit", () => kill("SIGKILL"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    await writes;
    if (outputError) throw outputError;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`Program exited with code ${code}; see ${program.stderr}`);
  } finally {
    signal.removeEventListener("abort", abort); clearTimeout(forced);
    // Close the entire process group: a completed command must not leave background writers behind.
    kill("SIGKILL"); stdout.destroy(); stderr.destroy();
  }
}
