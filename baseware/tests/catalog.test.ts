import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BasewareCore } from "../src/core.ts";
import { listen } from "../src/server.ts";
import { capabilityDocument } from "../src/catalog.ts";
import { structuredResult, toolExecution } from "../src/tool-contract.ts";
import type { Controller } from "../src/contracts.ts";

test("catalog, CLI JSON/file and Python share the same native arguments without shell encoding", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "baseware-catalog-")));
  const socket = join(workspace, "service.sock");
  const inputs: unknown[] = [];
  const image = { type: "image" as const, mimeType: "image/png", data: Buffer.from("native image").toString("base64") };
  const controller: Controller = { tool: { name: "fixture.echo", description: "native schema", inputSchema: {
    type: "object", properties: { value: { type: "string" }, duration: { type: "number", minimum: 0 } }, required: ["value"], additionalProperties: false,
  }, annotations: { readOnlyHint: true }, _meta: { "fixture/source": "unchanged" } }, requiresControl: false,
    async execute(args) {
      inputs.push(args);
      const result = structuredResult(args);
      result.content.unshift(image);
      return toolExecution({ id: "fixture", now: () => 1 }, 0, result);
    } };
  const core = new BasewareCore({ capabilities: { controllers: [controller] }, drivers: [{ id: "fixture", version: "1" }] });
  const close = await listen(socket, core);
  const entry = resolve(import.meta.dir, "../src/main.ts");
  const invoke = async (args: string[], expected = 0) => {
    const child = Bun.spawn(args, { cwd: workspace, env: { ...process.env, BASEWARE_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(expected);
    return stdout;
  };
  try {
    await invoke([process.execPath, entry, "export"]);
    const document = JSON.parse(await readFile(join(workspace, "baseware.json"), "utf8"));
    expect(document).toMatchObject({ schemaVersion: 2, controllers: core.list().controllers });
    expect(document.invocation.inputSchema.properties.controllerId.enum).toEqual(["fixture.echo"]);
    expect(document.executionResultSchema.required).toContain("result");
    expect(document.commandEncoding).toBeUndefined();
    expect(inputs).toHaveLength(0);
    const args = { value: "A B; $(do-not-run)\n引号\"", duration: 0.5 };
    const cliResult = JSON.parse(await invoke([process.execPath, entry, "controller", "fixture.echo", "--args", JSON.stringify(args)]));
    expect(cliResult.result.content[0]).toEqual(image);
    const file = join(workspace, "args.json");
    await writeFile(file, JSON.stringify(args));
    await invoke([process.execPath, entry, "controller", "fixture.echo", "--file", file]);
    const python = `import sys, json\nsys.path.insert(0, ${JSON.stringify(resolve(import.meta.dir, "../python"))})\nfrom baseware import Client\nargs = json.load(open(${JSON.stringify(file)}))\nprint(json.dumps(Client().controller('fixture.echo', args)))`;
    const pythonResult = JSON.parse(await invoke(["python3", "-B", "-c", python]));
    expect(pythonResult.result.structuredContent).toEqual(args);
    expect(pythonResult.result.content[0]).toEqual(image);
    expect(inputs).toEqual([args, args, args]);
    await invoke([process.execPath, entry, "controller", "fixture.echo", "--args", '{"value":"x","duration":"0.5"}'], 1);
    expect(inputs).toHaveLength(3);
    expect(capabilityDocument(core.list()).controllers[0]).toMatchObject(controller.tool);
    expect(core.status().mode).toBe("manual");
  } finally { await close(); await rm(workspace, { recursive: true, force: true }); }
});
