import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PerceptionRuntime, type PerceptionRead } from "../src/harness/perception.ts";
import { dispatch, listen } from "../src/harness/transport.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test("perception injection CLI changes only context policy and rejects stale epochs", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-injection-")));
  const socket = `/tmp/rsa-injection-${crypto.randomUUID()}.sock`;
  const events: { type: string; data: any; trace: any }[] = [];
  const runtime = createTestRuntime({ controllers: [] }, (type, data, trace) => events.push({ type, data, trace }));
  runtime.perception = new PerceptionRuntime({ workspace, runDir: join(workspace, "logs", "test"), record: runtime.record });
  const close = await listen(socket, runtime);
  const run = async (args: string[], epoch?: string) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), ...args], {
      cwd: workspace, env: { ...process.env, RSA_SOCKET: socket, BASEWARE_EPOCH: epoch,
        BASEWARE_TRACE: JSON.stringify({ modelCallId: "context-change" }) }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const read = (query = {}) => dispatch(runtime, { kind: "perception", argv: ["observe"], query }) as Promise<PerceptionRead>;
  const reload = async () => {
    await runtime.perception!.reload();
    const deadline = Date.now() + 4000;
    while (runtime.perception!.status().state === "loading" && Date.now() < deadline) await Bun.sleep(10);
    expect(runtime.perception!.status().state).toBe("ready");
  };
  try {
    await writeFile(join(workspace, "perception.py"), `from rsa_tools import capability, record
class Perception:
    sample_hz = 20
    def start(self, context): self.count = 0
    def close(self): pass
    @record
    @capability
    def sample(self):
        self.count += 1
        return {"text": str(self.count)}
`);
    await reload();
    const generation = runtime.perception.status().generation;
    const first = await read();
    expect(JSON.parse((await run(["perception", "inject"])).stdout)).toEqual({ perceptionInjection: true });
    const { epoch } = await runtime.start();
    const off = await run(["perception", "inject", "off"], epoch!);
    expect({ code: off.code, stderr: off.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(off.stdout)).toEqual({ perceptionInjection: false });
    expect(runtime.status()).toMatchObject({ mode: "auto", epoch, context: { perceptionInjection: false },
      perception: { state: "ready", generation } });
    const next = await read();
    expect(next.snapshot!.sequence).toBeGreaterThan(first.snapshot!.sequence);
    const historical = await read({ id: first.snapshot!.id });
    expect(historical.snapshot!.id).toBe(first.snapshot!.id);
    expect(historical.result.stdout).toBe(first.result.stdout);

    const stale = await run(["perception", "inject", "on"], "old-epoch");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("STALE_EPOCH");
    expect(runtime.perceptionInjectionEnabled()).toBe(false);
    expect((await run(["perception", "inject", "maybe"], epoch!)).code).toBe(1);
    await run(["perception", "inject", "off"], epoch!);
    const changes = events.filter(event => event.type === "context_policy");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ data: { perceptionInjection: false },
      trace: { epoch, modelCallId: "context-change" } });

    await reload();
    expect(runtime.perceptionInjectionEnabled()).toBe(false);
    await runtime.stop();
    await runtime.start();
    expect(JSON.parse((await run(["status"])).stdout).context).toEqual({ perceptionInjection: false });
    expect(JSON.parse((await run(["perception", "inject", "on"])).stdout)).toEqual({ perceptionInjection: true });
    expect(runtime.perception.status().state).toBe("ready");
  } finally { await runtime.close(); await close(); await rm(workspace, { recursive: true, force: true }); }
}, 15_000);

test("context policy works before perception exists and help distinguishes stop from inject off", async () => {
  const runtime = createTestRuntime({ controllers: [] });
  const freshHost = createTestRuntime({ controllers: [] });
  try {
    expect(await dispatch(runtime, { kind: "perception", argv: ["inject", "off"] })).toEqual({ perceptionInjection: false });
    expect(runtime.perception).toBeUndefined();
    expect(freshHost.perceptionInjectionEnabled()).toBe(true);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/app/main.ts"), "perception", "inject", "--help"],
      { env: { ...process.env, RSA_SOCKET: "/tmp/unused-context-help.sock" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("inject off disables automatic observation attachment");
    expect(stdout).toContain("stop ends the sampling process and timeline writer");
  } finally { await runtime.close(); await freshHost.close(); }
});
