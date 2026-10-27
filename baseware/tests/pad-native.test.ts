import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareClient } from "../src/client.ts";
import { BasewareCore } from "../src/core.ts";
import type { ExecutionResult, ToolArguments } from "../src/contracts.ts";
import { createAzaharProvider } from "../src/drivers/azahar/provider.ts";
import type { DeviceEvent } from "../src/protocol.ts";
import { listen } from "../src/server.ts";

// Exercises the checked-in native bridge and real provider/service/CLI. Only the
// emulator HID consumer is simulated (4 ms polls); no game or renderer is loaded.
const compiler = Bun.which("clang++");
const nativeTest = compiler && process.platform !== "win32" ? test : test.skip;
type Sample = { atMs: number; owned: number; buttons: number; touch: number };
async function until(check: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Native bridge condition timed out");
    await Bun.sleep(2);
  }
}

nativeTest("native pad timeline survives caller exit and wait cancellation; takeover releases pad and touch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-native-"));
  const root = join(import.meta.dir, "..");
  const includes = join(directory, "include");
  let provider: Awaited<ReturnType<typeof createAzaharProvider>> | undefined;
  let close: (() => Promise<void>) | undefined;
  let processHandle: ReturnType<typeof Bun.spawn> | undefined;
  let reader: Promise<void> | undefined;
  try {
    await mkdir(join(includes, "core/frontend"), { recursive: true });
    await copyFile(join(root, "src/drivers/azahar/rsa_bridge.h"), join(includes, "core/frontend/rsa_bridge.h"));
    const executable = join(directory, "azahar-pad");
    const build = Bun.spawn([compiler!, "-std=c++17", "-pthread", "-I", includes,
      join(import.meta.dir, "fixtures/azahar-pad.cpp"), join(root, "src/drivers/azahar/rsa_bridge.cpp"), "-o", executable],
    { stdout: "pipe", stderr: "pipe" });
    const buildError = await new Response(build.stderr).text();
    expect(await build.exited, buildError).toBe(0);
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const native = Bun.spawn([executable, String(port)], { stdout: "pipe", stderr: "pipe" });
    processHandle = native;
    const samples: Sample[] = [];
    let ready = false;
    reader = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of native.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (line.ready) ready = true; else samples.push(line);
        }
      }
    })();
    await until(() => ready);
    provider = await createAzaharProvider({ port, clock: { id: "native-test", now: () => performance.now() } });
    const events: DeviceEvent[] = [];
    const core = new BasewareCore({ capabilities: provider.capabilities, drivers: [{ id: "azahar", version: provider.version }],
      record: (type, data, trace = {}, metadata) => events.push({ type, data, trace, source: metadata!.source!, origin: metadata!.origin! }) });
    const socket = join(directory, "service.sock");
    close = await listen(socket, core);
    const owner = await BasewareClient.connect(socket);
    const observer = await BasewareClient.connect(socket);
    const epoch = "native-timeline";
    await owner.request({ kind: "acquire", epoch, seconds: 30 });
    const command = async (id: string, args: ToolArguments, signal?: AbortSignal) => observer.request({ kind: "controller", id, arguments: args, epoch }, signal) as Promise<ExecutionResult>;

    const begin = samples.length;
    const played = await command("pad.play", { inputs: [
      { atMs: 0, durationMs: 500, state: { LEFT: 1 } },
      { atMs: 0, durationMs: 300, state: { B: 1 } },
    ], wait: true });
    expect(JSON.parse(played.stdout)).toMatchObject({ status: "completed" });
    await until(() => samples.slice(begin).some(s => s.buttons === 256) && samples.at(-1)?.buttons === 0);
    const sampled = samples.slice(begin);
    const first = sampled.findIndex(s => s.buttons === 258);
    const transitions = sampled.slice(first);
    expect(transitions.map(s => s.buttons)).toEqual([258, 256, 0]);
    expect(transitions[1].atMs - transitions[0].atMs).toBeGreaterThanOrEqual(300);
    expect(transitions[1].atMs - transitions[0].atMs).toBeLessThan(450);
    expect(transitions[2].atMs - transitions[0].atMs).toBeGreaterThanOrEqual(500);
    expect(transitions[2].atMs - transitions[0].atMs).toBeLessThan(650);

    const cli = Bun.spawn([process.execPath, "src/main.ts", "controller", "pad.play", "--args",
      '{"inputs":[{"atMs":0,"durationMs":5000,"state":{"LEFT":1,"B":1}}]}'], {
      cwd: root, env: { ...process.env, BASEWARE_SOCKET: socket, BASEWARE_EPOCH: epoch,
        BASEWARE_TRACE: JSON.stringify({ toolCallId: "native-cli", traceId: "native-timeline" }) }, stdout: "pipe", stderr: "pipe",
    });
    const submitted = JSON.parse(JSON.parse(await new Response(cli.stdout).text()).stdout);
    expect(await cli.exited, await new Response(cli.stderr).text()).toBe(0);
    expect(submitted.status).toBe("running");
    await until(() => samples.at(-1)?.buttons === 258);
    expect(core.status().mode).toBe("auto");
    const abort = new AbortController();
    const waiting = command("pad.wait", { actionId: submitted.actionId }, abort.signal);
    await Bun.sleep(20);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(JSON.parse((await command("pad.status", { actionId: submitted.actionId })).stdout).status).toBe("running");
    expect(samples.at(-1)?.buttons).toBe(258);
    await command("touch.down", { x: 20, y: 30 });
    await until(() => samples.at(-1)?.touch === 1);
    await observer.request({ kind: "revoke" });
    await until(() => samples.at(-1)?.owned === 0 && samples.at(-1)?.buttons === 0 && samples.at(-1)?.touch === 0);
    expect(core.status()).toMatchObject({ mode: "manual", reason: "human" });
    await until(() => events.some(e => e.type === "action_end" && (e.data as any).actionId === submitted.actionId));
    const actionEvents = events.filter(e => ["action_start", "action_end"].includes(e.type) && (e.data as any).actionId === submitted.actionId);
    expect(actionEvents.map(e => e.type)).toEqual(["action_start", "action_end"]);
    expect(actionEvents[0].trace.toolCallId).toBe("native-cli");
    expect(actionEvents[1].trace).toEqual(actionEvents[0].trace);
    expect(actionEvents[1].data).toMatchObject({ status: "interrupted" });

    const nextEpoch = "native-owner-disconnect";
    await owner.request({ kind: "acquire", epoch: nextEpoch, seconds: 30 });
    await observer.request({ kind: "controller", id: "pad.play", epoch: nextEpoch,
      arguments: { inputs: [{ atMs: 0, durationMs: 5000, state: { A: 1 } }] } });
    await observer.request({ kind: "controller", id: "touch.down", epoch: nextEpoch, arguments: { x: 1, y: 1 } });
    await until(() => samples.at(-1)?.buttons === 1 && samples.at(-1)?.touch === 1);
    owner.close();
    await until(() => core.status().mode === "manual" && samples.at(-1)?.owned === 0 && samples.at(-1)?.buttons === 0 && samples.at(-1)?.touch === 0);
    expect(core.status().reason).toBe("owner disconnected");
    observer.close();
  } finally {
    await close?.();
    provider?.close();
    processHandle?.kill();
    await processHandle?.exited;
    await reader;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
