import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzaharProvider, encodeSpans } from "../src/drivers/azahar/provider.ts";

type Request = { id: string; op: string; args: string[]; socket: Socket };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const reply = ({ socket, id }: Request, fields: string[] = []) => socket.write([id, "OK", ...fields].join("\t") + "\n");

async function fixture(run: (provider: Awaited<ReturnType<typeof createAzaharProvider>>, requests: Request[], directory: string) => Promise<void>,
  handle?: (request: Request) => boolean) {
  const directory = await mkdtemp(join(tmpdir(), "baseware-azahar-"));
  const requests: Request[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const [id, op, ...args] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        const request = { id, op, args, socket };
        requests.push(request);
        if (handle?.(request)) continue;
        if (op === "HELLO") reply(request, ["azahar-rsa-2"]);
        else if (op === "TOUCH_INFO") reply(request, ["0", "0", "319", "239"]);
        else if (op === "OWN" || op === "DISOWN" || op === "STOP") reply(request);
        else if (op === "STATE") reply(request, ["4097", "32767", "0", "0", "-32767", "-"]);
        else if (op === "APPLY") reply(request, ["completed", "30000", "1800"]);
        else if (op === "CAPTURE") void writeFile(args[0], png).then(() => reply(request, ["17"]));
        else if (op.startsWith("TOUCH_")) reply(request, ["completed"]);
        else socket.write(`${id}\tERROR\tUnexpected ${op}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createAzaharProvider({ port: (server.address() as AddressInfo).port,
    artifactsDir: directory, clock: { id: "test", now: () => performance.now() } });
  try { await run(provider, requests, directory); }
  finally {
    provider.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  }
}

test("Azahar encodes real 3DS channels and accepts caller-selected long durations", () => {
  expect(encodeSpans([{ state: { A: 1, ZL: 1, LX: -1, RY: 0.5 }, durationMs: 30_000 },
    { state: {}, durationMs: 16 }])).toBe("4097:-32767:0:0:16384:30000,0:0:0:0:0:16");
  const invalid: Record<string, number>[] = [{ PLUS: 1 }, { A: 0.5 }, { LX: 1.1 }];
  for (const state of invalid) {
    expect(() => encodeSpans([{ state, durationMs: 16 }])).toThrow();
  }
  for (const durationMs of [15, 16.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => encodeSpans([{ state: {}, durationMs }])).toThrow();
  }
});

test("Azahar offers only native pad, touch and screen with a shared lease", async () => {
  await fixture(async (provider, requests) => {
    expect(provider.version).toBe("2126.2-rsa.2");
    expect(provider.capabilities.controllers.map(c => c.id)).toEqual(["pad", "touch", "screen"]);
    const [pad, touch] = provider.capabilities.controllers;
    await pad.acquire!("epoch");
    await touch.acquire!("epoch");
    const context = { epoch: "epoch", signal: new AbortController().signal };
    const state = JSON.parse((await pad.execute(["state"], context)).stdout);
    expect(state.state).toMatchObject({ A: 1, ZL: 1, LX: 1, RY: -1 });
    expect(state.actionId).toBeNull();
    await touch.execute(["down", "--x", "319", "--y", "239"], context);
    const applied = await pad.execute(["apply", "--state", '{"RIGHT":1}', "--for-ms", "30000"], context);
    expect(JSON.parse(applied.stdout)).toEqual({ elapsedMs: 30000, inputPolls: 1800 });
    expect(requests.find(r => r.op === "APPLY")!.args).toEqual(["epoch", "1024:0:0:0:0:30000"]);
    await pad.release!("epoch");
    await touch.release!("epoch");
    expect(requests.filter(r => r.op === "OWN")).toHaveLength(1);
    expect(requests.filter(r => r.op === "DISOWN")).toHaveLength(1);
    await expect(pad.execute(["state"], context)).rejects.toThrow("STALE_EPOCH");
  });
});

test("Azahar captures the complete native PNG without inventing a presented-frame sequence", async () => {
  await fixture(async (provider, requests) => {
    const screen = provider.capabilities.controllers.find(c => c.id === "screen")!;
    const signal = new AbortController().signal;
    const result = await screen.execute(["capture"], { signal });
    const observation = result.observations![0];
    expect(await readFile(observation.path)).toEqual(png);
    expect(observation.controllerId).toBe("screen");
    expect(observation.sourceSequence).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({ captureSequence: 17 });
    expect(requests.filter(r => r.op === "OWN")).toHaveLength(0);
    expect(requests.find(r => r.op === "CAPTURE")!.args).toEqual([observation.path]);
    await expect(screen.execute(["capture", "--crop", "bottom"], { signal })).rejects.toThrow();
    expect(requests.filter(r => r.op === "CAPTURE")).toHaveLength(1);
  });
});

test("Azahar cancels a long pad action by request ID without discarding ownership", async () => {
  let pending: Request | undefined;
  await fixture(async (provider, requests) => {
    const pad = provider.capabilities.controllers.find(c => c.id === "pad")!;
    await pad.acquire!("epoch");
    const abort = new AbortController();
    const action = pad.execute(["apply", "--state", '{"A":1}', "--for-ms", "30000"],
      { epoch: "epoch", signal: abort.signal });
    while (!pending) await Bun.sleep(1);
    abort.abort();
    const result = await action;
    expect(result.status).toBe("interrupted");
    expect(result.exitCode).toBe(130);
    const stop = requests.find(r => r.op === "STOP")!;
    expect(stop.args).toEqual(["epoch", pending.id]);
    expect(stop.id).not.toBe(pending.id);
    expect(requests.some(r => r.op === "DISOWN")).toBe(false);
    await pad.execute(["state"], { epoch: "epoch", signal: new AbortController().signal });
  }, request => {
    if (request.op === "APPLY") { pending = request; return true; }
    if (request.op === "STOP") {
      reply(pending!, ["interrupted", "1", "1"]); reply(request); return true;
    }
    return false;
  });
});
