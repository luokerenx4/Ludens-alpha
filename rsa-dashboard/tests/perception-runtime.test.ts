import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perceptionRuntime, perceptionSettings, updatePerceptionSettings } from "../lib/perception-config";
import { DashboardWorker } from "../lib/dashboard-worker";
import { resolveWorkspaceAddress } from "../../rsa/src/harness/workspace-state";
import { registerWorkspace } from "../../shared/ludens";
import { registerFixture } from "./fixtures/registry";
import { GET } from "../app/api/perception-config/runtime/route";

const values = { hotSeconds: 90.5, videoSegmentSeconds: 7200, videoIdleSeconds: 4 };
const ready = () => ({ state: "ready", generation: "generation-1", pid: 1234, sampleHz: 30,
  history: { ...values, persistent: true } });

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "perception-runtime-")));
  const home = join(base, "home"), workspace = join(base, "workspace"), runId = "current-run";
  await registerFixture(home, "selected", workspace);
  const run = join(workspace, "logs", runId);
  await mkdir(run, { recursive: true });
  const manifest = { workspace, workspaceId: "selected", runId, socket: "/tmp/never-use-manifest.sock" };
  await writeFile(join(run, "manifest.json"), JSON.stringify(manifest));
  const { socket } = await resolveWorkspaceAddress(workspace);
  const requests: unknown[] = [], connections = new Set<Socket>();
  let response: unknown = { runId, connected: false, perception: ready() };
  const server = createServer(client => {
    connections.add(client); client.on("close", () => connections.delete(client));
    client.setEncoding("utf8");
    let buffer = "";
    client.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      requests.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      if (response === "no-response") return;
      client.end(response === "invalid-json" ? "{\n" : JSON.stringify({ ok: true, value: response }) + "\n");
    });
    client.on("error", () => {});
  });
  let listening = false;
  return { base, home, workspace, run, runId, manifest, requests,
    respond(value: unknown) { response = value; },
    async listen() {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      listening = true;
    },
    async cleanup() {
      for (const client of connections) client.destroy();
      if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("runtime reads the canonical live host independently of saved settings, catalogs, and device connectivity", async () => {
  const f = await fixture(), worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: f.home } });
  try {
    await f.listen();
    await writeFile(join(f.home, "registry", "unrelated.json"), "{");
    await writeFile(join(f.workspace, ".rsa", "settings.json"), "{");
    const before = await readdir(join(f.workspace, ".rsa"));
    const result = await worker.call("perceptionRuntime", ["selected", f.workspace]);
    assert.equal(result.connection, "reachable", "connected:false describes the device, not the host transport");
    assert.equal(result.runId, f.runId);
    assert.equal(result.perception?.valueStatus, "current");
    assert.deepEqual(result.perception?.values, values);
    assert.equal(result.perception?.persistent, true);
    assert.equal(result.perception?.sampleHz, 30);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.deepEqual(f.requests, [{ kind: "status", argv: [] }], "no start, reload, observe, or controller request");
    assert.equal(await readFile(join(f.workspace, ".rsa", "settings.json"), "utf8"), "{");
    assert.deepEqual(await readdir(join(f.workspace, ".rsa")), before);
    await assert.rejects(perceptionSettings("selected", f.workspace, f.home), SyntaxError);
  } finally { await worker.close(); await f.cleanup(); }
});

test("stopped, failed, loading, unimplemented, and incomplete status never claim current values", async () => {
  const f = await fixture();
  try {
    await f.listen();
    for (const state of ["stopped", "error", "loading", "unimplemented"]) {
      f.respond({ runId: f.runId, perception: { ...ready(), state } });
      const result = await perceptionRuntime("selected", f.workspace, f.home);
      assert.equal(result.perception?.valueStatus, "last-loaded", state);
      assert.deepEqual(result.perception?.values, values);
    }
    for (const patch of [{ pid: undefined }, { pid: -4 }, { generation: null }, { generation: "" }]) {
      f.respond({ runId: f.runId, perception: { ...ready(), ...patch } });
      assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).perception?.valueStatus, "last-loaded");
    }
    for (const history of [{ hotSeconds: 10 }, { ...values, videoIdleSeconds: "4" }, { ...values, hotSeconds: -1 }]) {
      f.respond({ runId: f.runId, perception: { ...ready(), history } });
      const result = await perceptionRuntime("selected", f.workspace, f.home);
      assert.equal(result.perception?.values, null);
      assert.equal(result.perception?.valueStatus, "unavailable");
    }
    f.respond({ runId: f.runId });
    assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).perception, null);
  } finally { await f.cleanup(); }
});

test("foreign or missing run manifests and malformed host responses cannot become current evidence", async () => {
  const f = await fixture();
  try {
    await f.listen();
    for (const patch of [{ runId: "different" }, { workspaceId: "foreign" }, { workspace: "/other" }, { kind: "benchmark" }]) {
      await writeFile(join(f.run, "manifest.json"), JSON.stringify({ ...f.manifest, ...patch }));
      assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).reason, "scope-mismatch");
    }
    await writeFile(join(f.run, "manifest.json"), JSON.stringify(f.manifest));
    for (const response of [null, { runId: "../escape" }, { runId: f.runId, perception: { state: "invented" } }, "invalid-json"]) {
      f.respond(response);
      const result = await perceptionRuntime("selected", f.workspace, f.home);
      assert.equal(result.reason, "invalid-status");
      assert.equal(result.perception, null);
    }
    f.respond({ runId: "not-recorded", perception: ready() });
    assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).reason, "scope-mismatch");
  } finally { await f.cleanup(); }
});

test("unavailable runtime never prevents an independent save and does not read historical values", async () => {
  const f = await fixture();
  try {
    assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).reason, "not-running");
    await writeFile(join(f.home, "registry", "unrelated.json"), "{");
    assert.deepEqual(await updatePerceptionSettings("selected", { hotSeconds: 120 }, f.workspace, f.home), { hotSeconds: 120 });
    assert.deepEqual(await perceptionSettings("selected", f.workspace, f.home), { hotSeconds: 120 });
    await f.listen(); f.respond("no-response");
    assert.equal((await perceptionRuntime("selected", f.workspace, f.home)).reason, "unresponsive");
    assert.deepEqual(await updatePerceptionSettings("selected", { hotSeconds: null }, f.workspace, f.home), {});
  } finally { await f.cleanup(); }
});

test("all perception operations reject stale canonical paths even when the old path now aliases the moved workspace", async () => {
  const f = await fixture();
  try {
    const moved = join(f.base, "moved");
    await rename(f.workspace, moved);
    await symlink(moved, f.workspace);
    await registerWorkspace(moved, f.home);
    for (const work of [
      () => perceptionSettings("selected", f.workspace, f.home),
      () => updatePerceptionSettings("selected", { hotSeconds: 120 }, f.workspace, f.home),
      () => perceptionRuntime("selected", f.workspace, f.home),
    ]) await assert.rejects(work(), { code: "WORKSPACE_SCOPE_CHANGED", status: 409 });
    assert.deepEqual(await perceptionSettings("selected", moved, f.home), {});
    await assert.rejects(readFile(join(moved, ".rsa", "settings.json")), { code: "ENOENT" });
    for (const work of [
      () => perceptionSettings("selected", "", f.home),
      () => updatePerceptionSettings("selected", {}, "", f.home),
      () => perceptionRuntime("selected", "", f.home),
    ]) await assert.rejects(work(), { code: "WORKSPACE_SCOPE_REQUIRED", status: 400 });
    assert.deepEqual(f.requests, []);
  } finally { await f.cleanup(); }
});

test("runtime endpoint rejects nonlocal reads before contacting a host", async () => {
  const response = await GET(new Request("http://untrusted.test/api/perception-config/runtime?project=selected", {
    headers: { host: "untrusted.test" },
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /本地/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
