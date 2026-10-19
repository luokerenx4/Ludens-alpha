import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGbaProvider } from "../src/providers/mgba/provider.ts";

test.skipIf(process.env.RSA_BRIDGE_TEST !== "1")("bridge survives repeated disconnects, including a connection lost during input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-bridge-"));
  try {
    for (let i = 0; i < 5; i++) {
      const provider = await createGbaProvider({ port: 47653, artifactsDir: directory, clock: { id: "test", now: () => performance.now() } });
      const controller = provider.capabilities.controllers[0];
      const epoch = crypto.randomUUID();
      await controller.acquire(epoch);
      if (i === 0) {
        const action = controller.execute(["apply", "--state", '{"LEFT":1}', "--for-ms", "30000"], { epoch, signal: new AbortController().signal });
        const outcome = action.then((value) => value, (error: Error) => error);
        await Bun.sleep(50);
        provider.close();
        const result = await outcome;
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toContain("disconnected");
      } else {
        const result = await controller.execute(["state"], { epoch, signal: new AbortController().signal });
        expect(Object.values(JSON.parse(result.stdout).state).every((v) => v === 0)).toBe(true);
        const observation = await provider.capabilities.sensors[0].read(["capture"], new AbortController().signal);
        expect((await Bun.file(observation[0].path).arrayBuffer()).byteLength).toBeGreaterThan(100);
        await controller.release(epoch);
        provider.close();
      }
      await Bun.sleep(80); // Let mGBA's frame callback observe peer closure.
    }
  } finally { await rm(directory, { recursive: true }); }
}, 10000);
