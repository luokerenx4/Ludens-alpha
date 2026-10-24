import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGbaProvider } from "../src/drivers/mgba/provider.ts";

test.skipIf(process.env.RSA_BRIDGE_TEST !== "1")("bridge survives repeated disconnects, including a connection lost during input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-bridge-"));
  try {
    for (let i = 0; i < 5; i++) {
      const provider = await createGbaProvider({ port: 47653, artifactsDir: directory, clock: { id: "test", now: () => performance.now() } });
      const tool = (name: string) => provider.capabilities.controllers.find(c => c.tool.name === name)!;
      const controller = tool("pad.play");
      const epoch = crypto.randomUUID();
      await controller.acquire!(epoch);
      if (i === 0) {
        const context = { epoch, signal: new AbortController().signal };
        const action = JSON.parse((await controller.execute({ inputs: [{ atMs: 0, durationMs: 30000, state: { LEFT: 1 } }] }, context)).stdout);
        const outcome = tool("pad.wait").execute({ actionId: action.actionId }, context);
        await Bun.sleep(50);
        provider.close();
        const result = await outcome;
        expect(result.status).toBe("failed");
        expect(result.stderr).toContain("disconnected");
      } else {
        const result = await tool("pad.state").execute({}, { epoch, signal: new AbortController().signal });
        expect(Object.values(JSON.parse(result.stdout).state).every((v) => v === 0)).toBe(true);
        const observation = (await tool("screen.capture").execute({}, { signal: new AbortController().signal })).observations!;
        expect((await Bun.file(observation[0].path).arrayBuffer()).byteLength).toBeGreaterThan(100);
        await controller.release!(epoch);
        provider.close();
      }
      await Bun.sleep(80); // Let mGBA's frame callback observe peer closure.
    }
  } finally { await rm(directory, { recursive: true }); }
}, 10000);
