import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareClient } from "../src/client.ts";
import { BasewareCore } from "../src/core.ts";
import type { Controller, ExecutionResult, ToolArguments } from "../src/contracts.ts";
import { createPadPlayer } from "../src/drivers/pad.ts";
import type { Bridge } from "../src/drivers/bridge.ts";
import { padTools } from "../src/drivers/schema.ts";
import { structuredResult, toolExecution } from "../src/tool-contract.ts";
import type { DeviceEvent } from "../src/protocol.ts";
import { listen } from "../src/server.ts";

async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Service condition timed out");
    await Bun.sleep(2);
  }
}

// Host/service boundary only. Native HID timing and bridge tests live with each driver.
test("an async input survives CLI exit and waiter cancellation, but not takeover or owner disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-pad-service-"));
  const clock = { id: "service-fixture", now: () => performance.now() };
  const state = { owner: undefined as string | undefined, held: false, touch: false };
  let finish: ((fields: string[]) => void) | undefined;
  const stop = () => { state.held = false; state.touch = false; finish?.(["interrupted"]); finish = undefined; };
  const bridge = { async request(op: string) {
    if (op === "STOP") { stop(); return []; }
    if (op !== "APPLY") throw new Error(op);
    state.held = true;
    return new Promise<string[]>(resolve => { finish = resolve; });
  } } as unknown as Bridge;
  const player = createPadPlayer({ bridge, clock, encode: JSON.stringify, decode: () => ({}) });
  const acquire = async (epoch: string) => {
    if (state.owner === epoch) return;
    player.reset(); state.owner = epoch;
  };
  const release = async () => { state.owner = undefined; stop(); await player.settle(); };
  const controllers: Controller[] = padTools(["A"], [], "Fixture lifetime").filter(t => ["pad.play", "pad.wait", "pad.status"].includes(t.name))
    .map(tool => ({ tool, requiresControl: true, acquire, release,
      execute: (args, context) => player.execute(tool.name.slice(4), args, context) }));
  controllers.push({ tool: { name: "touch.down", inputSchema: { type: "object" } }, requiresControl: true, acquire, release,
    async execute() { state.touch = true; return toolExecution(clock, clock.now(), structuredResult({})); } });
  const events: DeviceEvent[] = [];
  const core = new BasewareCore({ capabilities: { controllers }, drivers: [{ id: "fixture", version: "1" }],
    record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, source: metadata!.source!, origin: metadata!.origin! }) });
  const socket = join(directory, "service.sock");
  const close = await listen(socket, core);
  const owner = await BasewareClient.connect(socket), observer = await BasewareClient.connect(socket);
  const epoch = "cli-owner";
  const command = (id: string, args: ToolArguments, signal?: AbortSignal) => observer.request({ kind: "controller", id, arguments: args, epoch }, signal) as Promise<ExecutionResult>;
  try {
    await owner.request({ kind: "acquire", epoch, seconds: 30 });
    const cli = Bun.spawn([process.execPath, "src/main.ts", "controller", "pad.play", "--args",
      '{"inputs":[{"atMs":0,"durationMs":5000,"state":{"A":1}}]}'], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, BASEWARE_SOCKET: socket, BASEWARE_EPOCH: epoch,
        BASEWARE_TRACE: JSON.stringify({ toolCallId: "fixture-cli", traceId: "input-lifetime" }) }, stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    expect(code, error).toBe(0);
    const submitted = JSON.parse(JSON.parse(output).stdout);
    expect(submitted.status).toBe("running");
    expect(state.held).toBe(true);
    expect(core.status().mode).toBe("auto");

    const abort = new AbortController();
    const waiting = command("pad.wait", { actionId: submitted.actionId }, abort.signal);
    await Bun.sleep(20);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(JSON.parse((await command("pad.status", { actionId: submitted.actionId })).stdout).status).toBe("running");
    await command("touch.down", {});
    expect(state.touch).toBe(true);
    await observer.request({ kind: "revoke" });
    expect(state).toEqual({ owner: undefined, held: false, touch: false });
    expect(core.status()).toMatchObject({ mode: "manual", reason: "human" });
    await until(() => events.some(e => e.type === "action_end" && (e.data as any).actionId === submitted.actionId));
    const lifecycle = events.filter(e => ["action_start", "action_end"].includes(e.type) && (e.data as any).actionId === submitted.actionId);
    expect(lifecycle.map(e => e.type)).toEqual(["action_start", "action_end"]);
    expect(lifecycle[0].trace.toolCallId).toBe("fixture-cli");
    expect(lifecycle[1].trace).toEqual(lifecycle[0].trace);
    expect(lifecycle[1].data).toMatchObject({ status: "interrupted" });

    const nextEpoch = "next-owner";
    await owner.request({ kind: "acquire", epoch: nextEpoch, seconds: 30 });
    await observer.request({ kind: "controller", id: "pad.play", epoch: nextEpoch,
      arguments: { inputs: [{ atMs: 0, durationMs: 5000, state: { A: 1 } }] } });
    await observer.request({ kind: "controller", id: "touch.down", epoch: nextEpoch, arguments: {} });
    expect(state).toEqual({ owner: nextEpoch, held: true, touch: true });
    owner.close();
    await until(() => core.status().mode === "manual");
    expect(state).toEqual({ owner: undefined, held: false, touch: false });
    expect(core.status().reason).toBe("owner disconnected");
  } finally {
    owner.close(); observer.close(); await close(); await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
