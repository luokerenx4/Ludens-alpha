import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "./driver-fixture.ts";
import { createAzaharProvider, encodeSpans } from "../src/drivers/azahar/provider.ts";

type Request = { id: string; op: string; args: string[]; socket: Socket };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const pngs = { top: png, bottom: Buffer.concat([png, Buffer.from("bottom")]) };
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
        if (op === "HELLO") reply(request, ["azahar-rsa-3"]);
        else if (op === "TOUCH_INFO") reply(request, ["0", "0", "319", "239"]);
        else if (op === "OWN" || op === "DISOWN" || op === "STOP") reply(request);
        else if (op === "STATE") reply(request, ["4097", "32767", "0", "0", "-32767", "-"]);
        else if (op === "APPLY") reply(request, ["completed", "30000", "1800"]);
        else if (op === "CAPTURE") void writeFile(args[1], pngs[args[0] as "top" | "bottom"]).then(() => reply(request, ["17"]));
        else if (op.startsWith("TOUCH_")) reply(request, ["completed"]);
        else socket.write(`${id}\tERROR\tUnexpected ${op}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createAzaharProvider({ port: (server.address() as AddressInfo).port,
    clock: { id: "test", now: () => performance.now() } });
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

test("Azahar offers native pad, touch and two independent screens with a shared lease", async () => {
  await fixture(async (provider, requests) => {
    expect(provider.version).toBe("2126.2-rsa.3");
    expect(provider.capabilities.controllers.map(c => c.tool.name)).toEqual(["pad.state", "pad.play", "pad.status", "pad.wait", "pad.cancel", "pad.release", "touch.down", "touch.move", "touch.up", "screen.top.capture", "screen.bottom.capture"]);
    const tool = (name: string) => provider.capabilities.controllers.find(c => c.tool.name === name)!;
    const pad = tool("pad.play"), touch = tool("touch.down");
    expect(provider.capabilities.controllers.some(c => c.tool.name === "pad.apply")).toBe(false);
    expect(pad.tool.inputSchema).toMatchObject({ properties: {
      inputs: { type: "array", items: { properties: {
        state: { properties: { ZL: { enum: [0, 1] }, RY: { minimum: -1, maximum: 1 } }, additionalProperties: false },
        durationMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      } } },
      wait: { type: "boolean", default: false },
    } });
    await pad.acquire!("epoch");
    await touch.acquire!("epoch");
    const context = { epoch: "epoch", signal: new AbortController().signal };
    const state = JSON.parse((await call(tool("pad.state"), {}, context)).stdout);
    expect(state.state).toMatchObject({ A: 1, ZL: 1, LX: 1, RY: -1 });
    expect(state.actionId).toBeNull();
    await call(touch, { x: 319, y: 239 }, context);
    const applied = await call(pad, { inputs: [{ atMs: 0, durationMs: 30000, state: { RIGHT: 1 } }], wait: true }, context);
    expect(JSON.parse(applied.stdout)).toMatchObject({ status: "completed", elapsedMs: 30000, inputPolls: 1800 });
    expect(requests.find(r => r.op === "APPLY")!.args).toEqual(["epoch", "1024:0:0:0:0:30000"]);
    await pad.release!("epoch");
    await touch.release!("epoch");
    expect(requests.filter(r => r.op === "OWN")).toHaveLength(1);
    expect(requests.filter(r => r.op === "DISOWN")).toHaveLength(1);
    await expect(call(tool("pad.state"), {}, context)).rejects.toThrow("STALE_EPOCH");
  });
});

test("Azahar samples independent hardware screens without combining or inventing presented-frame sequences", async () => {
  await fixture(async (provider, requests) => {
    const signal = new AbortController().signal;
    const paths: string[] = [];
    for (const source of ["top", "bottom"] as const) {
      const screen = provider.capabilities.controllers.find(c => c.tool.name === `screen.${source}.capture`)!;
      expect(screen.tool).toMatchObject({ name: `screen.${source}.capture`, inputSchema: { properties: {}, additionalProperties: false } });
      const result = await call(screen, {}, { signal });
      const observation = result.observations![0];
      expect(result.observations).toHaveLength(1);
      expect(observation.path).toBeUndefined();
      expect(observation.controllerId).toBe(`screen.${source}.capture`);
      expect(observation.sourceSequence).toBeUndefined();
      expect(result.result.structuredContent).toMatchObject({ source: `screen.${source}`, captureSequence: 17, timing: result.timing });
      expect(result.result.content[observation.contentIndex!]).toEqual({ type: "image", data: pngs[source].toString("base64"), mimeType: "image/png" });
      const capture = requests.filter(r => r.op === "CAPTURE").at(-1)!;
      expect(capture.args[0]).toBe(source);
      await expect(access(capture.args[1])).rejects.toThrow();
      expect(screen.tool.description).toContain(source === "top" ? "400×240" : "320×240");
      await expect(call(screen, { crop: "bottom" }, { signal })).rejects.toThrow();
      paths.push(capture.args[1]);
    }
    expect(paths[0]).not.toBe(paths[1]);
    expect(requests.filter(r => r.op === "OWN")).toHaveLength(0);
    expect(requests.filter(r => r.op === "CAPTURE")).toHaveLength(2);
  });
});

test("Azahar serializes concurrent source captures without merging their observations", async () => {
  let active = false;
  await fixture(async (provider, requests) => {
    const top = provider.capabilities.controllers.find(c => c.tool.name === "screen.top.capture")!;
    const bottom = provider.capabilities.controllers.find(c => c.tool.name === "screen.bottom.capture")!;
    const signal = new AbortController().signal;
    const results = await Promise.all([
      call(top, {}, { signal }), call(bottom, {}, { signal }),
    ]);
    expect(requests.filter(r => r.op === "CAPTURE").map(r => r.args[0])).toEqual(["top", "bottom"]);
    expect(results.map(r => r.observations![0].controllerId)).toEqual(["screen.top.capture", "screen.bottom.capture"]);
    expect(results.every(result => result.observations![0].path === undefined)).toBe(true);
    expect(results[1].timing.requestedAtMs).toBeGreaterThanOrEqual(results[0].timing.receivedAtMs);
    expect(results[1].timing.receivedAtMs).toBeGreaterThan(results[0].timing.receivedAtMs);
    for (let index = 0; index < results.length; index++) {
      expect(results[index].observations).toHaveLength(1);
      expect(results[index].result.content[0]).toMatchObject({ type: "image", data: (index === 0 ? pngs.top : pngs.bottom).toString("base64") });
      await expect(access(requests.filter(r => r.op === "CAPTURE")[index].args[1])).rejects.toThrow();
    }
    const abort = new AbortController();
    const first = call(top, {}, { signal });
    const queued = call(bottom, {}, { signal: abort.signal }).catch(error => error);
    abort.abort();
    await first;
    expect(await queued).toBeInstanceOf(Error);
    expect(requests.filter(r => r.op === "CAPTURE")).toHaveLength(3);
  }, request => {
    if (request.op !== "CAPTURE") return false;
    if (active) { request.socket.write(`${request.id}\tERROR\tCAPTURE_BUSY\n`); return true; }
    active = true;
    void (async () => {
      await Bun.sleep(10);
      await writeFile(request.args[1], pngs[request.args[0] as "top" | "bottom"]);
      active = false;
      reply(request, ["17"]);
    })();
    return true;
  });
});

test("Azahar submits overlapping inputs asynchronously and cancels by action ID", async () => {
  let pending: Request | undefined;
  await fixture(async (provider, requests) => {
    const tool = (name: string) => provider.capabilities.controllers.find(c => c.tool.name === name)!;
    const pad = tool("pad.play");
    await pad.acquire!("epoch");
    const abort = new AbortController();
    const context = { epoch: "epoch", signal: abort.signal };
    const submitted = await call(pad, { inputs: [
      { atMs: 0, durationMs: 500, state: { LEFT: 1 } },
      { atMs: 0, durationMs: 300, state: { B: 1 } },
    ] }, context);
    const action = JSON.parse(submitted.stdout);
    expect(action.status).toBe("running");
    while (!pending) await Bun.sleep(1);
    expect(action.actionId).toBe(pending!.id);
    expect(pending!.args).toEqual(["epoch", "258:0:0:0:0:300,256:0:0:0:0:200"]);
    abort.abort();
    await Bun.sleep(5);
    expect(requests.some(r => r.op === "STOP")).toBe(false);
    const nextContext = { epoch: "epoch", signal: new AbortController().signal };
    const cancelled = await call(tool("pad.cancel"), { actionId: action.actionId }, nextContext);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({ actionId: action.actionId, status: "interrupted" });
    expect(requests.find(r => r.op === "STOP")!.args).toEqual(["epoch", action.actionId]);
    expect(requests.some(r => r.op === "DISOWN")).toBe(false);
    await call(tool("pad.state"), {}, nextContext);
    expect(provider.capabilities.controllers.some(c => c.tool.name === "pad.apply")).toBe(false);
    await expect(call(tool("pad.state"), { inputs: [] }, nextContext)).rejects.toThrow();
    await expect(call(tool("pad.release"), { extra: true }, nextContext)).rejects.toThrow();
  }, request => {
    if (request.op === "APPLY") { pending = request; return true; }
    if (request.op === "STATE" && pending) { reply(request, ["258", "0", "0", "0", "0", pending.id]); return true; }
    if (request.op === "STOP") {
      reply(pending!, ["interrupted", "1", "1"]); reply(request); return true;
    }
    return false;
  });
});
