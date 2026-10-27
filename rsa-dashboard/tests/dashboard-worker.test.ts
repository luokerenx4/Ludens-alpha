import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DashboardWorker } from "../lib/dashboard-worker";
import { errorResponse } from "../lib/local-request";

const file = resolve("tests/fixtures/dashboard-worker.mjs");

test("worker routes concurrent replies and forwards preparation status without retaining finished calls", async () => {
  const worker = new DashboardWorker({ file });
  try {
    const [slow, fast] = await Promise.all([
      worker.call("aliceConsumer", [{ delay: 25, value: "slow" }]),
      worker.call("aliceConsumer", [{ value: "fast" }]),
    ]);
    assert.equal(slow, "slow"); assert.equal(fast, "fast"); assert.equal(worker.pendingCount, 0);
    const error = await worker.call("aliceConsumer", [{ error: true }]).then(() => assert.fail("expected preparation"), error => error);
    const response = errorResponse(error);
    assert.equal(response.status, 202); assert.equal(response.headers.get("Retry-After"), "1");
    assert.deepEqual(await response.json(), { error: "preparing", code: "ARCHIVE_PREPARING", progress: { read: 100, total: 1000 } });
  } finally { await worker.close(); }
});

test("aborting one request cancels its worker operation and leaves another subscriber running", async () => {
  const worker = new DashboardWorker({ file });
  try {
    await worker.call("catalog", []);
    const abort = new AbortController();
    const cancelled = worker.call("aliceConsumer", [{ delay: 60_000 }], abort.signal);
    const other = worker.call("aliceConsumer", [{ delay: 10, value: "still running" }]);
    abort.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(await other, "still running");
    assert.deepEqual(await worker.call("aliceState", []), { cancelled: 1 });
    assert.equal(worker.pendingCount, 0);
  } finally { await worker.close(); }
});

test("worker crash rejects in-flight calls without replaying mutations; a later request can start a fresh worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-worker-crash-")), mutations = join(root, "mutations");
  const worker = new DashboardWorker({ file, env: { ...process.env, WORKER_MUTATIONS: mutations } });
  try {
    await worker.call("catalog", []);
    const pending = worker.call("aliceConsumer", [{ delay: 60_000 }]);
    const crash = worker.call("aliceConsumer", [{ crash: true }]);
    for (const result of await Promise.allSettled([pending, crash])) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason.status, 503);
    }
    assert.equal(worker.pendingCount, 0);
    assert.equal(await readFile(mutations, "utf8"), "mutation\n");
    assert.deepEqual(await worker.call("catalog", []), []);
    assert.equal(await readFile(mutations, "utf8"), "mutation\n");
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker request cap, timeout and shutdown release pending listeners", async () => {
  const worker = new DashboardWorker({ file, maxPending: 1, timeoutMs: 500 });
  try {
    await worker.call("catalog", []);
    const pending = worker.call("aliceConsumer", [{ delay: 60_000 }]);
    await assert.rejects(worker.call("catalog", []), { status: 503 });
    await assert.rejects(pending, /timed out/);
    assert.equal(worker.pendingCount, 0);
    const closing = worker.call("aliceConsumer", [{ delay: 60_000 }]);
    const rejected = assert.rejects(closing, /closing/);
    await worker.close(); await rejected;
    assert.equal(worker.pendingCount, 0);
    assert.throws(() => worker.call("catalog", []), /closed/);
  } finally { await worker.close(); }
});

test("real TypeScript backend boots outside Next and reads only its configured artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-worker-real-"));
  const worker = new DashboardWorker({ env: { ...process.env, RSA_DASHBOARD_ARTIFACT_ROOT: root } });
  try {
    assert.deepEqual(await worker.call("catalog", []), []);
    await assert.rejects(worker.call("run", ["../outside", "run"]), /无效|Invalid/);
    const diagnostics = await worker.call("diagnostics", []);
    assert.equal(diagnostics.activeRequests, 0); assert.equal(diagnostics.index.leased, 0);
    assert.equal(worker.pendingCount, 0);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
