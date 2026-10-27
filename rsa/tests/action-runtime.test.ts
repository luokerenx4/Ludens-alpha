import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenDevice } from "@playness/baseware/server";
import { createPadPlayer } from "../../baseware/src/drivers/pad.ts";
import type { Bridge } from "../../baseware/src/drivers/bridge.ts";
import { ActionRuntime } from "../src/harness/action.ts";
import { connectBaseware } from "../src/harness/baseware.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen, send } from "../src/harness/transport.ts";
import { pythonEnvironment } from "../../shared/python.ts";

async function until(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = performance.now() + 5000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function fixture(hz = 30, diagnostics: "normal" | "full" = "normal", seconds = 30,
  grant?: (install: () => Promise<void>) => Promise<void>) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-action-")));
  const runDir = join(workspace, "logs", "run-action");
  const socket = `/tmp/rsa-action-${crypto.randomUUID()}.sock`, deviceSocket = `/tmp/bw-action-${crypto.randomUUID()}.sock`;
  const events: { type: string; data: any; trace: any; channel?: string }[] = [];
  const record = (type: string, data: unknown, trace = {}, metadata?: any) => events.push({ type, data, trace, ...metadata });
  const held = new Set<string>(), states: string[][] = [];
  let finish: ((outcome: string[]) => void) | undefined, timers: ReturnType<typeof setTimeout>[] = [], reads = 0;
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers = []; held.clear(); states.push([]); finish?.(["interrupted"]); finish = undefined; };
  const bridge = { request: async (command: string, fields: string[]) => {
    if (command === "STOP") { clear(); return []; }
    if (command !== "APPLY") throw new Error(command);
    const inputs = JSON.parse(fields[1]!) as { key: string; durationMs: number }[];
    for (const input of inputs) held.add(input.key);
    states.push([...held].sort());
    return new Promise<string[]>(resolve => {
      finish = resolve;
      for (const input of inputs) timers.push(setTimeout(() => {
        held.delete(input.key); states.push([...held].sort());
        if (!held.size) { finish = undefined; resolve(["completed"]); }
      }, input.durationMs));
    });
  }} as unknown as Bridge;
  const player = createPadPlayer({ bridge, clock: { id: "fixture", now: () => performance.now() }, encode: JSON.stringify, decode: () => ({}) });
  const core = new BasewareCore({ drivers: [], record, diagnostics, capabilities: { controllers: [
    { tool: { name: "play", inputSchema: { type: "object" } }, requiresControl: true,
      async acquire() { player.reset(); }, async release() { clear(); await player.settle(); },
      execute: (args, context) => player.execute("play", args, context) },
    { tool: { name: "sensor", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, requiresControl: false,
      async execute() { reads++; return { id: crypto.randomUUID(), status: "completed" as const, exitCode: 0,
        stdout: "", stderr: "", result: { content: [] }, timing: { clock: "fixture", requestedAtMs: 0, receivedAtMs: 1 } }; } },
  ] }});
  const closeDevice = await listenDevice(deviceSocket, core);
  const devices = await connectBaseware({ socket: deviceSocket, seconds, runDir, record });
  const env = pythonEnvironment({ RSA_SOCKET: socket, RSA_WORKSPACE: workspace, RSA_RUN_ID: "run-action", RSA_LOG_DIAGNOSTICS: diagnostics });
  const runtime = new Runtime(devices, record, seconds, "run-action", diagnostics);
  runtime.controller = new WorkspaceController({ workspace, devices, record, env });
  runtime.perception = new PerceptionRuntime({ workspace, runDir, record, env, diagnostics });
  runtime.action = new ActionRuntime({ workspace, runDir, record, env, diagnostics,
    isAuto: epoch => runtime.status().mode === "auto" && runtime.status().epoch === epoch,
    setInputGeneration: (epoch, generation) => generation && grant
      ? grant(() => devices.setInputGeneration!(epoch, generation)) : devices.setInputGeneration!(epoch, generation),
    onCleanupError: error => { void runtime.stop(error.message); } });
  const closeHost = await listen(socket, runtime);
  await writeFile(join(workspace, "perception.py"), `from rsa_tools import capability, record
class Perception:
    sample_hz = 30
    def start(self, context): self.n = 0
    @record
    @capability
    def sample(self):
        self.n += 1
        return {"data": {"sample": self.n}}
    def close(self): pass
`);
  const source = (body?: string) => `from rsa_tools import Client, capability, record
import os
class Action:
    step_hz = ${hz}
    def start(self, context):
        self.device = Client()
        self.n = 0
        with open("initializations", "a") as f: f.write(str(os.getpid()) + "\\n")
    @record
    @capability
    def step(self):
${body ?? `        self.n += 1
        reading = self.device.observe()
        if reading.get("error"): raise RuntimeError(reading["error"])
        self.device.call("controller/sensor")
        if self.n == 1:
            result = self.device.call("controller/play", {"wait": False, "inputs": [{"key": "left", "durationMs": 600}, {"key": "jump", "durationMs": 300}]})
            self.action_id = result["actionId"]
        return {"data": {"tick": self.n, "pid": os.getpid(), "actionId": self.action_id}, "sources": [{"recordId": reading["snapshot"]["id"]}]}`}
    def close(self): pass
`;
  await writeFile(join(workspace, "action.py"), source());
  await runtime.perception.reload();
  await until(() => runtime.perception!.status().state === "ready", "perception ready");
  return { workspace, runDir, runtime, core, events, socket, states, held, source, reads: () => reads,
    write: (text: string) => writeFile(join(workspace, "action.py"), text),
    async history() { return runtime.perception!.observe(new AbortController().signal, {}, { capability: "python/action.py:Action.step" }); },
    async close() { await runtime.close(); devices.close(); await closeHost(); await closeDevice(); await rm(workspace, { recursive: true, force: true }); },
  };
}

test("real resident processes compose history and async input without per-tick audit at 1/10/30 Hz", async () => {
  const report = [];
  for (const [hz, diagnostics] of [[1, "normal"], [10, "normal"], [30, "normal"], [10, "full"]] as const) {
    const f = await fixture(hz, diagnostics);
    try {
      const perceptionPid = f.runtime.perception!.status().pid;
      await f.runtime.start();
      await until(() => f.runtime.action!.status().state === "ready", JSON.stringify(f.runtime.action!.status()));
      const actionPid = f.runtime.action!.status().pid;
      const epoch = f.runtime.status().epoch!;
      await Bun.sleep(1150);
      const history = await f.history();
      expect(history.error).toBeUndefined();
      const data = history.records![0]!.data as any;
      expect(data.tick).toBeGreaterThanOrEqual(hz);
      expect(data.pid).toBe(actionPid);
      expect(actionPid).not.toBe(perceptionPid);
      expect(f.states).toContainEqual(["jump", "left"]);
      expect(f.states).toContainEqual(["left"]);
      expect(f.held.size).toBe(0);
      const deadline = f.runtime.status().remainingSeconds!;
      await f.runtime.action!.stop();
      expect(f.runtime.status()).toMatchObject({ mode: "auto", epoch });
      expect(f.runtime.status().remainingSeconds!).toBeLessThanOrEqual(deadline);
      expect(f.runtime.perception!.status()).toMatchObject({ pid: perceptionPid, state: "ready" });
      expect((await readFile(join(f.workspace, "initializations"), "utf8")).trim().split("\n")).toHaveLength(1);
      const stats = f.events.filter(event => event.type === "action_stats");
      expect(stats).toHaveLength(1);
      expect(stats.reduce((n, event) => n + event.data.step.completed, 0)).toBeGreaterThanOrEqual(data.tick);
      expect(stats[0]!.trace).toMatchObject({ epoch, inputGeneration: f.runtime.action!.status().generation });
      const tickEvents = f.events.filter(event => ["python_call_start", "python_call_end", "capability_start", "capability_end", "perception_observe_start", "perception_observe_end"].includes(event.type) && event.trace.recordingPurpose === "continuous-action");
      if (diagnostics === "normal") expect(tickEvents).toHaveLength(0);
      else expect(tickEvents.every(event => event.channel === "diagnostic")).toBe(true);
      expect(f.events.filter(event => event.type === "action_start")).toHaveLength(1);
      expect(f.events.filter(event => event.type === "action_end")).toHaveLength(1);
      expect(f.events.findLast(event => event.type === "action_status")!.trace.epoch).toBe(epoch);
      report.push({ hz, diagnostics, steps: data.tick, hostTickEvents: tickEvents.length, actionStats: stats.length });
    } finally { await f.close(); }
  }
  console.log("action-runtime", JSON.stringify(report));
}, 30000);

test("reload replaces only Action, rejects stale generation and handback releases a submitted job", async () => {
  const f = await fixture();
  try {
    await f.runtime.start();
    await until(() => f.runtime.action!.status().state === "ready");
    const old = f.runtime.action!.status(), epoch = f.runtime.status().epoch!;
    const perceptionPid = f.runtime.perception!.status().pid;
    await f.write(f.source().replace('"durationMs": 600', '"durationMs": 60000').replace('"durationMs": 300', '"durationMs": 30000'));
    await send(f.socket, { kind: "action", argv: ["reload"], epoch });
    await until(() => f.runtime.action!.status().state === "ready");
    expect(f.runtime.action!.status().pid).not.toBe(old.pid);
    expect(f.runtime.perception!.status().pid).toBe(perceptionPid);
    expect(f.runtime.status().epoch).toBe(epoch);
    expect(f.held.size).toBe(2);
    await expect(send(f.socket, { kind: "controller", argv: [], action: "call", id: "controller/sensor", epoch,
      trace: { inputGeneration: old.generation! } })).rejects.toThrow("STALE_INPUT_GENERATION");
    const staleCli = Bun.spawn([process.execPath, join(import.meta.dir, "../src/app/main.ts"), "action", "stop"], {
      cwd: f.workspace, env: { ...process.env, RSA_SOCKET: f.socket, BASEWARE_EPOCH: epoch,
        BASEWARE_TRACE: JSON.stringify({ inputGeneration: old.generation! }) }, stdout: "pipe", stderr: "pipe",
    });
    const [staleCode, staleError] = await Promise.all([staleCli.exited, new Response(staleCli.stderr).text()]);
    expect(staleCode).not.toBe(0);
    expect(staleError).toContain("STALE_INPUT_GENERATION");
    await f.runtime.stop("human");
    expect(f.runtime.status()).toMatchObject({ mode: "manual", reason: "human", action: { state: "idle", pid: undefined } });
    expect(f.held.size).toBe(0);
    expect(f.events.filter(event => event.type === "action_end").at(-1)!.data.status).toBe("interrupted");
    expect(f.events.filter(event => event.type === "action_status").at(-1)!.trace.epoch).toBe(epoch);
    const count = f.reads();
    await Bun.sleep(100);
    expect(f.reads()).toBe(count);
    await f.runtime.action!.reload(); // Manual reload only arms; no Python executes.
    expect(f.runtime.action!.status()).toMatchObject({ state: "idle", enabled: true });
    expect(f.runtime.action!.status().pid).toBeUndefined();
    expect((await readFile(join(f.workspace, "initializations"), "utf8")).trim().split("\n")).toHaveLength(2);
  } finally { await f.close(); }
}, 15000);

test("a failed step or abrupt worker exit clears inputs and does not replay", async () => {
  const f = await fixture();
  try {
    for (const ending of ['raise RuntimeError("failed after submit")', 'os._exit(9)']) {
      await f.write(f.source(`        self.device.call("controller/play", {"wait": False, "inputs": [{"key": "left", "durationMs": 60000}]})
        ${ending}`));
      if (f.runtime.status().mode === "manual") await f.runtime.start();
      else await f.runtime.action!.reload(f.runtime.status().epoch!);
      await until(() => f.runtime.action!.status().state === "error" && !f.runtime.action!.status().pid, "worker failed and cleaned");
      expect(f.held.size).toBe(0);
      expect(f.runtime.status().mode).toBe("auto");
      const starts = f.events.filter(event => event.type === "action_start").length;
      await Bun.sleep(100);
      expect(f.events.filter(event => event.type === "action_start")).toHaveLength(starts);
    }
    expect(f.events.filter(event => event.type === "action_start")).toHaveLength(2);
    expect(f.events.filter(event => event.type === "action_end")).toHaveLength(2);
  } finally { await f.close(); }
}, 15000);

test("human handback during Python initialization cannot start steps or restore control", async () => {
  const f = await fixture();
  try {
    await f.write(f.source().replace('self.device = Client()', 'import time\n        time.sleep(60)\n        self.device = Client()'));
    const starting = f.runtime.start();
    await until(() => !!f.runtime.action!.status().pid, "loading process exists");
    await f.runtime.stop("human");
    await starting;
    expect(f.runtime.status()).toMatchObject({ mode: "manual", reason: "human" });
    expect(f.core.status()).toMatchObject({ mode: "manual", inputGeneration: null });
    expect(f.runtime.action!.status().pid).toBeUndefined();
    expect(f.events.filter(event => event.type === "action_start")).toHaveLength(0);
  } finally { await f.close(); }
}, 15000);


test("stop drains a delayed generation grant before it can report completion", async () => {
  for (const installedBeforeReply of [false, true]) {
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const f = await fixture(30, "normal", 30, async install => {
      if (installedBeforeReply) await install();
      entered.resolve();
      await held.promise;
      if (!installedBeforeReply) await install();
    });
    try {
      const starting = f.runtime.start();
      await entered.promise;
      const stopping = f.runtime.action!.stop();
      held.resolve();
      await Promise.all([starting, stopping]);
      expect(f.runtime.action!.status()).toMatchObject({ state: "stopped" });
      expect(f.runtime.action!.status().pid).toBeUndefined();
      expect(f.core.status()).toMatchObject({ mode: "auto", inputGeneration: null });
      expect(f.events.filter(event => event.type === "action_start")).toHaveLength(0);
    } finally { held.resolve(); await f.close(); }
  }
}, 15000);
