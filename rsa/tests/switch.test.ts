import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSwitchProvider, encodeSpans } from "../src/providers/ryubing/provider.ts";

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
  expect(() => encodeSpans([{ state: {}, durationMs: 1000 }, { state: {}, durationMs: 1001 }])).toThrow("2000");
});

async function withSwitchBridge(run: (provider: Awaited<ReturnType<typeof createSwitchProvider>>,
  captures: { path: string; atMs: number }[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "rsa-switch-capture-"));
  const captures: { path: string; atMs: number }[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const [id, op, path] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        if (op === "HELLO") socket.write(`${id}\tOK\tryubing-rsa-2\n`);
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
  try { await run(provider, captures); }
  finally {
    provider.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  }
}

test("Switch capture defaults to zero delay and includes a requested delay in its sampling interval", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.sensors[0];
    const signal = new AbortController().signal;
    const first = (await screen.read(["capture"], signal))[0];
    const second = (await screen.read(["capture", "--delay-ms", "0"], signal))[0];
    const delayed = (await screen.read(["capture", "--delay-ms", "40"], signal))[0];
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
    const screen = provider.capabilities.sensors[0];
    const signal = new AbortController().signal;
    for (const value of ["-1", "1.5", "NaN", "Infinity", "2147483648", "", " "]) {
      await expect(screen.read(["capture", `--delay-ms=${value}`], signal)).rejects.toThrow("delay-ms");
    }
    for (const argv of [["capture", "--delay-ms"], ["capture", "--unknown", "1"], ["capture", "extra"], ["wrong"]]) {
      await expect(screen.read(argv, signal)).rejects.toThrow();
    }
    expect(captures).toHaveLength(0);
  });
});

test("Switch capture cancellation during the delay never sends CAPTURE", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.sensors[0];
    const abort = new AbortController();
    const pending = screen.read(["capture", "--delay-ms", "80"], abort.signal).catch(error => error);
    await Bun.sleep(10);
    expect(captures).toHaveLength(0);
    abort.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    await Bun.sleep(90);
    expect(captures).toHaveLength(0);
    await expect(screen.read(["capture"], abort.signal)).rejects.toThrow();
    expect(captures).toHaveLength(0);
  });
});
