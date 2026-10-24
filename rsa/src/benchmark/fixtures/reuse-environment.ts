import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capabilities, ToolArguments, ToolExecutionResult } from "@playness/baseware/contracts";
import { structuredResult } from "@playness/baseware/tool-contract";
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
      controllers: [{ tool: { name: "bench.set", description: "Set one assembly dial.", inputSchema: { type: "object",
        properties: { slot: { type: "integer", minimum: 1, maximum: 3 }, value: { type: "integer", minimum: 0, maximum: 9 } },
        required: ["slot", "value"], additionalProperties: false } }, requiresControl: true,
        acquire: async () => {}, release: async () => {},
        execute: (args, context) => this.execute("set", args, context),
      }, { tool: { name: "bench.submit", description: "Submit the current assembly settings.", inputSchema: { type: "object", additionalProperties: false } },
        requiresControl: true, execute: (args, context) => this.execute("submit", args, context),
      }, { tool: { name: "screen.capture", description: "Read the assembly bench display", inputSchema: { type: "object", additionalProperties: false } }, requiresControl: false, mediaTypes: ["image/png"],
        execute: async (_args, { signal }) => {
          signal.throwIfAborted();
          const started = performance.now(), id = `bench-${++this.captures}`;
          const path = join(this.directory, `${id}.png`);
          await mkdir(this.directory, { recursive: true });
          const pixels = renderBoard(this.view());
          await writeFile(path, pixels);
          const timing = { clock: "benchmark-bench", requestedAtMs: started, receivedAtMs: performance.now() };
          return { id, status: "completed", exitCode: 0, stdout: "", stderr: "", timing,
            result: { content: [{ type: "image", mimeType: "image/png", data: pixels.toString("base64") }] },
            observations: [{ id, controllerId: "screen.capture", mediaType: "image/png", path, contentIndex: 0, sourceSequence: this.captures, timing }] };
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

  private async execute(action: "set" | "submit", args: ToolArguments, { epoch, signal }: { epoch?: string; signal: AbortSignal }): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const id = crypto.randomUUID(), started = performance.now();
    let ok = true, reply: Record<string, unknown>;
    if (this.done || (this.phase === 1 && this.accepted === 3)) {
      ok = false; reply = { accepted: false, message: this.done ? "All orders complete" : "Batch complete; return to receive the next batch" };
    } else if (action === "set") {
      this.values[Number(args.slot) - 1] = Number(args.value);
      this.notice = `SET SLOT ${args.slot} TO ${args.value}`;
      reply = { slot: args.slot, value: args.value };
    } else {
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
    }
    return { id, status: ok ? "completed" : "failed", exitCode: ok ? 0 : 2,
      result: { ...structuredResult(reply), ...(!ok ? { isError: true } : {}) },
      stdout: JSON.stringify(reply), stderr: "", timing: { clock: "benchmark-bench", requestedAtMs: started, receivedAtMs: performance.now() } };
  }
}
