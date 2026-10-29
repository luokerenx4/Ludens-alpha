import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityRuntime } from "../lib/capabilities";
import { DashboardWorker } from "../lib/dashboard-worker";
import { resolveWorkspaceAddress } from "../../rsa/src/harness/workspace-state";
import { registerFixture } from "./fixtures/registry";
import { GET } from "../app/api/capabilities/runtime/route";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "capability-runtime-")));
  const home = join(base, "home"), workspace = join(base, "workspace"), runId = "fixture-run";
  await registerFixture(home, "selected", workspace);
  const run = join(workspace, "logs", runId); await mkdir(run, { recursive: true });
  const manifest = { workspace, workspaceId: "selected", runId, socket: "/tmp/do-not-use-archived-socket.sock" };
  await writeFile(join(run, "manifest.json"), JSON.stringify(manifest));
  const { socket } = await resolveWorkspaceAddress(workspace);
  let response: unknown = { runId, connected: true };
  const requests: unknown[] = [], clients = new Set<Socket>();
  const server = createServer(client => {
    clients.add(client); client.once("close", () => clients.delete(client)); client.on("error", () => {});
    client.setEncoding("utf8"); let buffer = "";
    client.on("data", chunk => {
      buffer += chunk; if (!buffer.includes("\n")) return;
      requests.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      client.end(JSON.stringify({ ok: true, value: response }) + "\n");
    });
  });
  let listening = false;
  return { home, workspace, run, runId, manifest, requests,
    respond(value: unknown) { response = value; },
    async listen() { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); }); listening = true; },
    async cleanup() { for (const client of clients) client.destroy(); if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(base, { recursive: true, force: true }); },
  };
}

test("explicit runtime reads only canonical host status, independently of static capability/config errors", async () => {
  const f = await fixture(), worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: f.home } });
  try {
    await f.listen();
    for (const file of ["baseware.json", "rsa.json"]) await writeFile(join(f.workspace, file), "{");
    await writeFile(join(f.home, "registry", "unrelated.json"), "{");
    const result = await worker.call("capabilityRuntime", ["selected", f.workspace]);
    assert.equal(result.host, "reachable"); assert.equal(result.controlConnected, true); assert.equal(result.runId, f.runId);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.deepEqual(f.requests, [{ kind: "status", argv: [] }]);
    for (const file of ["baseware.json", "rsa.json"]) assert.equal(await readFile(join(f.workspace, file), "utf8"), "{");
    f.respond({ runId: f.runId, connected: false });
    const disconnected = await capabilityRuntime("selected", f.workspace, f.home);
    assert.equal(disconnected.host, "reachable"); assert.equal(disconnected.controlConnected, false);
    for (const connected of [undefined, "true", 1]) {
      f.respond({ runId: f.runId, connected });
      assert.equal((await capabilityRuntime("selected", f.workspace, f.home)).controlConnected, null);
    }
    assert.ok(f.requests.every(request => JSON.stringify(request) === JSON.stringify({ kind: "status", argv: [] })));
  } finally { await worker.close(); await f.cleanup(); }
});

test("offline, invalid, and foreign-run replies never establish device availability", async () => {
  const f = await fixture();
  try {
    const offline = await capabilityRuntime("selected", f.workspace, f.home);
    assert.equal(offline.host, "unavailable"); assert.equal(offline.reason, "not-running"); assert.equal(offline.controlConnected, null);
    await f.listen();
    for (const patch of [{ workspaceId: "foreign" }, { workspace: "/foreign" }, { runId: "other" }, { kind: "benchmark" }]) {
      await writeFile(join(f.run, "manifest.json"), JSON.stringify({ ...f.manifest, ...patch }));
      const result = await capabilityRuntime("selected", f.workspace, f.home);
      assert.equal(result.reason, "scope-mismatch"); assert.equal(result.controlConnected, null);
    }
    await writeFile(join(f.run, "manifest.json"), JSON.stringify(f.manifest));
    for (const value of [null, { runId: "../outside", connected: true }, { connected: true }]) {
      f.respond(value); assert.equal((await capabilityRuntime("selected", f.workspace, f.home)).reason, "invalid-status");
    }
    const requestCount = f.requests.length;
    await assert.rejects(capabilityRuntime("selected", "/stale", f.home), { code: "WORKSPACE_SCOPE_CHANGED" });
    await assert.rejects(capabilityRuntime("selected", "", f.home), { code: "WORKSPACE_SCOPE_REQUIRED" });
    assert.equal(f.requests.length, requestCount, "scope checks precede socket requests");
  } finally { await f.cleanup(); }
});

test("runtime HTTP endpoint rejects nonlocal access before opening a socket", async () => {
  const response = await GET(new Request("http://untrusted.test/api/capabilities/runtime", { headers: { host: "untrusted.test" } }));
  assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
});
