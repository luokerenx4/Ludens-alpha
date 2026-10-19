import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capabilities, ExecutionResult } from "@playness/baseware/contracts";
import type { EventTrace, RecordEvent } from "../../harness/events.ts";
import { renderBoard } from "./reuse-board.ts";

/** State is owned by the evaluator process, never by a file the agent edits. */
export class ReuseEnvironment {
  readonly capabilities: Capabilities;
  private readonly orders: number[][];
  private phase = 1;
  private index = 0;
  private values = [0, 0, 0];
  private accepted = 0;
  private notice = "READY";
  private captures = 0;

  constructor(seed: number, private readonly directory: string, private readonly record: RecordEvent) {
    let random = seed >>> 0;
    const digit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 9 + 1; };
    this.orders = [];
    while (this.orders.length < 6) {
      const target = [digit(), digit(), digit()];
      if (!this.orders.some(order => order.join() === target.join())) this.orders.push(target);
    }
    this.capabilities = {
      controllers: [{ id: "bench", help: () => "Set a dial or submit its current settings.\nset <slot:1..3> <digit:0..9>\nsubmit",
        acquire: async () => {}, release: async () => {},
        execute: (argv, context) => this.execute(argv, context),
      }],
      sensors: [{ id: "screen", mediaTypes: ["image/png"], help: () => "capture — read the assembly bench display",
        read: async (argv, signal) => {
          signal.throwIfAborted();
          if (argv.length !== 1 || argv[0] !== "capture") throw new Error("Usage: capture");
          const started = performance.now(), id = `bench-${++this.captures}`;
          const path = join(this.directory, `${id}.png`);
          await mkdir(this.directory, { recursive: true });
          await writeFile(path, renderBoard(this.view()));
          return [{ id, sensorId: "screen", mediaType: "image/png", path, sourceSequence: this.captures,
            timing: { clock: "benchmark-bench", requestedAtMs: started, receivedAtMs: performance.now() } }];
        },
      }],
    };
  }

  begin(trace: EventTrace) {
    this.record("benchmark_reuse_phase", { phase: 1, orders: 3 }, trace);
  }

  get done() { return this.accepted === 6; }

  /** Deliver the transfer batch only after the previous shell operation returns. */
  afterExec(trace: EventTrace) {
    if (this.phase !== 1 || this.accepted !== 3) return;
    this.phase = 2; this.index = 3; this.values = [0, 0, 0]; this.notice = "NEW BATCH READY";
    this.record("benchmark_reuse_phase", { phase: 2, orders: 3 }, trace);
  }

  summary() { return { completed: this.accepted, expected: 6, phase: this.phase }; }

  private view() {
    const waiting = this.phase === 1 && this.accepted === 3;
    return { phase: this.phase, order: this.index % 3 + 1, completed: this.accepted, values: this.values,
      target: waiting || this.done ? undefined : this.orders[this.index], waiting, done: this.done, notice: this.notice };
  }

  private async execute(argv: readonly string[], { epoch, signal }: { epoch: string; signal: AbortSignal }): Promise<ExecutionResult> {
    signal.throwIfAborted();
    const id = crypto.randomUUID(), started = performance.now();
    let ok = true, reply: Record<string, unknown>;
    if (this.done || (this.phase === 1 && this.accepted === 3)) {
      ok = false; reply = { accepted: false, message: this.done ? "All orders complete" : "Batch complete; return to receive the next batch" };
    } else if (argv[0] === "set" && argv.length === 3 && /^[1-3]$/.test(argv[1]!) && /^[0-9]$/.test(argv[2]!)) {
      this.values[Number(argv[1]) - 1] = Number(argv[2]);
      this.notice = `SET SLOT ${argv[1]} TO ${argv[2]}`;
      reply = { slot: Number(argv[1]), value: Number(argv[2]) };
    } else if (argv.length === 1 && argv[0] === "submit") {
      const target = this.orders[this.index]!;
      if (this.values.every((value, i) => value === target[i])) {
        const orderId = `batch-${this.phase}-order-${this.index % 3 + 1}`;
        this.accepted++; this.index++; this.values = [0, 0, 0]; this.notice = "ORDER ACCEPTED";
        reply = { accepted: true, orderId, phase: this.phase };
        this.record("benchmark_reuse_order", { executionId: id, orderId, phase: this.phase }, { epoch });
      } else {
        ok = false; this.notice = "SETTINGS DO NOT MATCH TARGET";
        reply = { accepted: false, message: "Settings do not match the current target" };
      }
    } else {
      ok = false; reply = { message: "Usage: set <slot:1..3> <digit:0..9> | submit" };
    }
    return { id, status: ok ? "completed" : "failed", exitCode: ok ? 0 : 2,
      stdout: JSON.stringify(reply), stderr: "", timing: { clock: "benchmark-bench", requestedAtMs: started, receivedAtMs: performance.now() } };
  }
}
