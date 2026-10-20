import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BasewareCore } from "../src/core.ts";
import { listen } from "../src/server.ts";
import { capabilityDocument } from "../src/catalog.ts";
import { createTouchController } from "../src/drivers/touch.ts";

test("export snapshots live driver schemas for CLI and Python without taking control or invoking a device", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "baseware-catalog-")));
  const socket = join(workspace, "service.sock");
  const requests: { operation: string; args: (string | number)[] }[] = [];
  const touch = await createTouchController({
    bridge: { async request(operation, args = []) { requests.push({ operation, args }); return ["0", "0", "319", "239"]; } },
    clock: { id: "touch-fixture", now: () => performance.now() },
    async acquire() {}, async release() {}, owns: () => false,
  });
  const core = new BasewareCore({ capabilities: { controllers: [touch] }, drivers: [{ id: "touch-fixture", version: "1" }] });
  const close = await listen(socket, core);
  const filename = join(workspace, "baseware.json");
  const environment = { ...process.env, BASEWARE_SOCKET: socket, BASEWARE_EPOCH: "should-not-be-exported" };
  const invoke = async (args: string[]) => {
    const child = Bun.spawn(args, { cwd: workspace, env: environment, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return stdout;
  };
  const entry = resolve(import.meta.dir, "../src/main.ts");
  try {
    await writeFile(filename, '{"old":true}');
    expect((await invoke([process.execPath, entry, "export"])).trim()).toBe(filename);
    const document = JSON.parse(await readFile(filename, "utf8"));
    expect(document).toMatchObject({ schemaVersion: 1, drivers: [{ id: "touch-fixture", version: "1" }], controllers: core.list().controllers });
    expect(Number.isNaN(Date.parse(document.generatedAt))).toBe(false);
    expect(document.invocation.inputSchema.properties.controllerId.enum).toEqual(["touch"]);
    expect(document.executionResultSchema.required).toContain("timing");
    const down = document.controllers[0].commands.find((command: any) => command.name === "down");
    expect(down.parameters.properties.x).toEqual({ type: "integer", minimum: 0, maximum: 319 });
    expect(down.bindings).toEqual([{ parameter: "x", flag: "--x", encoding: "string" }, { parameter: "y", flag: "--y", encoding: "string" }]);
    expect(JSON.stringify(document)).not.toContain(environment.BASEWARE_EPOCH);
    expect(JSON.stringify(document)).not.toContain(socket);
    const python = `import sys, json\nsys.path.insert(0, ${JSON.stringify(resolve(import.meta.dir, "../python"))})\nfrom baseware import Client\nprint(json.dumps(Client().list()))`;
    expect(JSON.parse(await invoke(["python3", "-B", "-c", python]))).toEqual(core.list());
    // A new discovery is used on refresh; the export is not a cached first snapshot.
    touch.commands![0]!.description = "Updated driver contract";
    const custom = join(workspace, "capabilities.json");
    expect((await invoke([process.execPath, entry, "export", "--output", custom])).trim()).toBe(custom);
    expect(JSON.parse(await readFile(custom, "utf8")).controllers[0].commands[0].description).toBe("Updated driver contract");
    expect(capabilityDocument(core.list()).controllers).toEqual(core.list().controllers);
    expect(core.status().mode).toBe("manual");
    expect(requests).toEqual([{ operation: "TOUCH_INFO", args: [] }]);
  } finally { await close(); await rm(workspace, { recursive: true, force: true }); }
});
