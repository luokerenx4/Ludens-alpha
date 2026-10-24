import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AXES, BUTTONS, createSwitchProvider, encodeSpans } from "../src/drivers/ryubing/provider.ts";

test("Switch controls encode complete digital and analog states without game semantics", () => {
  expect(encodeSpans([
    { state: { A: 1, ZL: 1, LX: -1, RY: 0.5 }, durationMs: 100 },
    { state: {}, durationMs: 16 },
  ])).toBe("257:-32767:0:0:16384:100,0:0:0:0:0:16");
  const invalidStates: Record<string, number>[] = [{ JUMP: 1 }, { A: 0.5 }, { LX: 1.1 }, { RY: NaN }];
  for (const state of invalidStates) {
    expect(() => encodeSpans([{ state, durationMs: 100 }])).toThrow("Invalid channel");
  }
  expect(() => encodeSpans([{ state: {}, durationMs: 15 }])).toThrow(">= 16");
});

test("Switch accepts long actions and sequences while rejecting invalid or unsafe durations", () => {
  expect(encodeSpans([{ state: { A: 1 }, durationMs: 30_000 }])).toBe("1:0:0:0:0:30000");
  expect(encodeSpans([
    { state: { A: 1 }, durationMs: 5_000 },
    { state: {}, durationMs: 25_000 },
  ])).toBe("1:0:0:0:0:5000,0:0:0:0:0:25000");
  for (const durationMs of [NaN, Infinity, 16.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => encodeSpans([{ state: {}, durationMs }])).toThrow();
  }
  expect(() => encodeSpans([
    { state: {}, durationMs: Number.MAX_SAFE_INTEGER },
    { state: {}, durationMs: 16 },
  ])).toThrow();
});

async function withSwitchBridge(run: (provider: Awaited<ReturnType<typeof createSwitchProvider>>,
  captures: { path: string; atMs: number }[], requests: string[], typed: string[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "rsa-switch-capture-"));
  const captures: { path: string; atMs: number }[] = [];
  const requests: string[] = [];
  const typed: string[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const [id, op, path, command, encoded] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        requests.push(op);
        if (op === "HELLO") socket.write(`${id}\tOK\tryubing-rsa-3\n`);
        else if (op === "OWN" || op === "DISOWN") socket.write(`${id}\tOK\n`);
        else if (op === "TOUCH_INFO") socket.write(`${id}\tOK\t0\t0\t1279\t719\n`);
        else if (op === "KEYBOARD" && command === "type") {
          typed.push(Buffer.from(encoded, "base64").toString());
          socket.write(`${id}\tOK\n`);
        }
        else if (op === "CAPTURE") {
          captures.push({ path, atMs: performance.now() });
          socket.write(`${id}\tOK\t${captures.length}\n`);
        } else socket.write(`${id}\tERROR\tUnexpected operation: ${op}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
    artifactsDir: directory, clock: { id: "test", now: () => performance.now() } });
  try { await run(provider, captures, requests, typed); }
  finally {
    provider.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  }
}

test("Switch capture defaults to zero delay and includes a requested delay in its sampling interval", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.id === "screen")!;
    expect(screen.commands).toMatchObject([{ name: "capture", parameters: {
      properties: { delayMs: { type: "integer", minimum: 0, maximum: 2_147_483_647, default: 0 } },
    }, bindings: [{ parameter: "delayMs", flag: "--delay-ms", encoding: "string" }] }]);
    const signal = new AbortController().signal;
    const first = (await screen.execute(["capture"], { signal })).observations![0];
    const second = (await screen.execute(["capture", "--delay-ms", "0"], { signal })).observations![0];
    const delayed = (await screen.execute(["capture", "--delay-ms", "40"], { signal })).observations![0];
    expect(captures).toHaveLength(3);
    expect(captures.map(capture => capture.path)).toEqual([first.path, second.path, delayed.path]);
    expect(first.sourceSequence).toBe(1);
    expect(second.sourceSequence).toBe(2);
    expect(delayed.sourceSequence).toBe(3);
    expect(captures[2].atMs - delayed.timing.requestedAtMs).toBeGreaterThanOrEqual(35);
    expect(delayed.timing.receivedAtMs).toBeGreaterThanOrEqual(captures[2].atMs);
  });
});

test("Switch capture rejects invalid delay arguments before contacting the bridge", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.id === "screen")!;
    const signal = new AbortController().signal;
    for (const value of ["-1", "1.5", "NaN", "Infinity", "2147483648", "", " "]) {
      await expect(screen.execute(["capture", `--delay-ms=${value}`], { signal })).rejects.toThrow("delay-ms");
    }
    for (const argv of [["capture", "--delay-ms"], ["capture", "--unknown", "1"], ["capture", "extra"], ["wrong"]]) {
      await expect(screen.execute(argv, { signal })).rejects.toThrow();
    }
    expect(captures).toHaveLength(0);
  });
});

test("Switch capture cancellation during the delay never sends CAPTURE", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.id === "screen")!;
    const abort = new AbortController();
    const pending = screen.execute(["capture", "--delay-ms", "80"], { signal: abort.signal }).catch(error => error);
    await Bun.sleep(10);
    expect(captures).toHaveLength(0);
    abort.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    await Bun.sleep(90);
    expect(captures).toHaveLength(0);
    await expect(screen.execute(["capture"], { signal: abort.signal })).rejects.toThrow();
    expect(captures).toHaveLength(0);
  });
});


test("Switch touch and pad share one owner acquisition and release", async () => {
  await withSwitchBridge(async (provider, _captures, requests) => {
    const pad = provider.capabilities.controllers.find(c => c.id === "pad")!;
    const touch = provider.capabilities.controllers.find(c => c.id === "touch")!;
    await pad.acquire!("epoch");
    await touch.acquire!("epoch");
    await touch.release!("epoch");
    await pad.release!("epoch");
    expect(requests.filter(op => op === "OWN")).toHaveLength(1);
    expect(requests.filter(op => op === "DISOWN")).toHaveLength(1);
    expect(touch.help()).toContain("x=0..1279, y=0..719");
    expect(touch.commands?.find(c => c.name === "down")?.parameters).toMatchObject({
      properties: { x: { maximum: 1279 }, y: { maximum: 719 } },
    });
  });
});

test("Switch catalog describes actual pad channels, sequence file contents and keyboard keys", async () => {
  await withSwitchBridge(async (provider, _captures, _requests, typed) => {
    const pad = provider.capabilities.controllers.find(c => c.id === "pad")!;
    const state = { type: "object", additionalProperties: false, properties: {
      ...Object.fromEntries(BUTTONS.map(key => [key, { type: "integer", enum: [0, 1] }])),
      ...Object.fromEntries(AXES.map(key => [key, { type: "number", minimum: -1, maximum: 1 }])),
    } };
    expect(pad.commands?.map(c => c.name)).toEqual(["state", "play", "status", "wait", "cancel", "release"]);
    expect(pad.commands?.find(c => c.name === "play")?.parameters).toMatchObject({ properties: {
      inputs: { type: "array", items: { properties: { state, durationMs: { minimum: 1 }, atMs: { minimum: 0 } }, required: ["atMs", "durationMs", "state"] } },
      file: { type: "string", "x-fileContentSchema": { type: "object", properties: {
        inputs: { type: "array", minItems: 1, items: { properties: { state, durationMs: { minimum: 1 } } } },
      }, required: ["inputs"] } },
      wait: { type: "string", enum: ["true", "false"], default: "false" },
    } });
    const keyboard = provider.capabilities.controllers.find(c => c.id === "keyboard")!;
    expect(keyboard.commands).toMatchObject([
      { name: "type", parameters: { properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "press", parameters: { properties: { key: { enum: ["ENTER", "ESCAPE", "BACKSPACE", "CTRL+A"] } }, required: ["key"] } },
    ]);
    const binding = keyboard.commands![0]!.bindings[0]!;
    expect(binding.style).toBe("joined");
    await keyboard.acquire!("epoch");
    await keyboard.execute(["type", `${binding.flag}=--help 文本`], { epoch: "epoch", signal: new AbortController().signal });
    expect(typed).toEqual(["--help 文本"]);
    await keyboard.release!("epoch");
  });
});

test("Switch release waits for a late action result before reporting release or reacquiring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-release-order-"));
  let owner: string | undefined;
  let finishAction: (() => void) | undefined;
  let acknowledged = Promise.withResolvers<void>();
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const [id, op, epoch] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        const ok = (...fields: string[]) => socket.write([id, "OK", ...fields].join("\t") + "\n");
        if (op === "HELLO") ok("ryubing-rsa-3");
        else if (op === "TOUCH_INFO") ok("0", "0", "1279", "719");
        else if (op === "OWN") {
          if (owner) socket.write(`${id}\tERROR\tOWNED\n`);
          else { owner = epoch; ok(); }
        } else if (op === "APPLY") finishAction = () => { ok("interrupted", "10", "2"); finishAction = undefined; };
        else if (op === "STOP" || op === "DISOWN") {
          if (op === "DISOWN") owner = undefined;
          ok(); // Ryubing schedules the APPLY completion asynchronously, after this acknowledgement.
          acknowledged.resolve();
        } else if (op === "CAPTURE") ok("1");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
    artifactsDir: directory, clock: { id: "release-order", now: () => performance.now() } });
  const pad = provider.capabilities.controllers[0];
  const screen = provider.capabilities.controllers.find(c => c.id === "screen")!;
  const context = {epoch: "old", signal: new AbortController().signal};
  try {
    await pad.acquire!(context.epoch);
    for (const disown of [false, true]) {
      acknowledged = Promise.withResolvers<void>();
      const action = JSON.parse((await pad.execute(["play", "--inputs", '[{"atMs":0,"durationMs":30000,"state":{"A":1}}]'], context)).stdout);
      let released = false;
      const releasing = (disown ? pad.release!(context.epoch) : pad.execute(["release"], context)).then(() => { released = true; });
      await acknowledged.promise;
      // This later response on the same socket proves the STOP/DISOWN reply was consumed,
      // without sleeps or depending on thread scheduling for the delayed action result.
      await screen.execute(["capture"], {signal: context.signal});
      expect(released).toBe(false);
      finishAction!();
      await releasing;
      if (!disown) expect(JSON.parse((await pad.execute(["wait", "--action", action.actionId], context)).stdout).status).toBe("interrupted");
    }
    await pad.acquire!("new");
    expect(owner).toBe("new");
    await pad.release!("new");
  } finally {
    finishAction?.();
    provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
