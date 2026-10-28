import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { EventMetadata, EventTrace, RecordEvent } from "./events.ts";

/** A local execution mode of Shiori. No trial, score, lease or budget ownership lives here. */
export interface Program {
  argv: string[]; cwd: string; env: NodeJS.ProcessEnv;
  stdout: string; stderr: string;
  /** Internal fixture programs forward their facts to the owning Shiori EventLog. */
  events?: boolean;
}
export type ProgramMessage =
  | { kind: "event"; type: string; data: unknown; trace?: EventTrace; metadata?: EventMetadata }
  | { kind: "flush" | "flushed"; id: string }
  | { kind: "ready" }
  | { kind: "budget"; deadlineMs: number }
  | { kind: "stop"; reason: "time budget" };
export async function executeProgram(program: Program, signal: AbortSignal, record: RecordEvent, deadlineMs: number, cancellation?: AbortSignal): Promise<void> {
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
  let exited = false, terminating = false, interrupted = false, budgetStopped = false;
  const kill = (name: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const abort = () => {
    if (exited || terminating) return;
    terminating = true;
    kill("SIGTERM");
    forced ??= setTimeout(() => kill("SIGKILL"), 2000);
  };
  const send = (message: ProgramMessage) => {
    if (child.connected) child.send(message, error => { if (error) { outputError ??= error; abort(); } });
  };
  const stop = () => {
    if (exited) return;
    interrupted = true;
    if (program.events && signal.reason instanceof DOMException && signal.reason.message === "time budget" && !cancellation?.aborted) {
      budgetStopped = true;
      send({ kind: "stop", reason: "time budget" });
      forced ??= setTimeout(() => kill("SIGKILL"), 2000);
    } else abort();
  };
  stdout.on("error", error => { outputError = error; abort(); });
  stderr.on("error", error => { outputError = error; abort(); });
  child.on("message", (message: ProgramMessage) => {
    try {
      if (program.events && message?.kind === "event" && typeof message.type === "string") record(message.type, message.data, message.trace, message.metadata);
      if (program.events && message?.kind === "flush") send({ kind: "flushed", id: message.id });
      if (program.events && message?.kind === "ready") {
        send({ kind: "budget", deadlineMs });
        if (budgetStopped) send({ kind: "stop", reason: "time budget" });
      }
    } catch (error) { outputError = error instanceof Error ? error : new Error(String(error)); abort(); }
  });
  // Descendants may inherit stdout/stderr. Kill them when the command exits,
  // before waiting for close/drain, or a background child can hold the pipes forever.
  child.once("exit", () => {
    exited = true;
    signal.removeEventListener("abort", stop);
    clearTimeout(forced);
    kill("SIGKILL");
  });
  signal.addEventListener("abort", stop, { once: true });
  cancellation?.addEventListener("abort", abort, { once: true });
  if (signal.aborted) stop();
  if (cancellation?.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    await writes;
    if (outputError) throw outputError;
    cancellation?.throwIfAborted();
    if (interrupted && !budgetStopped) signal.throwIfAborted();
    if (code !== 0) throw new Error(`Program exited with code ${code}; see ${program.stderr}`);
  } finally {
    signal.removeEventListener("abort", stop); cancellation?.removeEventListener("abort", abort); clearTimeout(forced);
    // Spawn failures may not emit exit; otherwise the exit handler already cleaned the group.
    if (!exited) kill("SIGKILL");
    stdout.destroy(); stderr.destroy();
  }
}
