import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadPoller } from "../lib/read-poller";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("a paused explicit snapshot reads once even when the source has more immediate pages", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const poller = new ReadPoller(async () => { reads++; return 0; }, false);
  t.after(() => poller.dispose());
  await poller.readOnce();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(reads, 1);
  await poller.readOnce();
  assert.equal(reads, 2, "an explicit return-to-current remains available while paused");
});

test("pausing cancels the scheduled read without an extra fetch; resume reads immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const poller = new ReadPoller(async () => { reads++; return 2500; }, true);
  t.after(() => poller.dispose());
  await poller.readOnce();
  poller.setEnabled(false);
  t.mock.timers.tick(10_000); await flush();
  assert.equal(reads, 1);
  poller.setEnabled(true); await flush();
  assert.equal(reads, 2);
  poller.setEnabled(true); await flush();
  assert.equal(reads, 2, "same enabled value must not restart a snapshot");
  t.mock.timers.tick(2500); await flush();
  assert.equal(reads, 3);
});

test("an in-flight read may finish after pause but cannot schedule more work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<number>();
  let reads = 0, signal: AbortSignal | undefined;
  const poller = new ReadPoller(async nextSignal => { signal = nextSignal; reads++; return pending.promise; }, true);
  t.after(() => poller.dispose());
  const first = poller.readOnce();
  poller.setEnabled(false);
  assert.equal(signal?.aborted, false);
  pending.resolve(0); await first;
  t.mock.timers.tick(10_000); await flush();
  assert.equal(reads, 1);
});

test("resume and explicit reads never overlap an in-flight snapshot", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<number>();
  let reads = 0;
  const poller = new ReadPoller(async () => { reads++; return pending.promise; }, false);
  t.after(() => poller.dispose());
  const first = poller.readOnce();
  poller.setEnabled(true);
  await poller.readOnce();
  assert.equal(reads, 1);
  pending.resolve(2500); await first;
  t.mock.timers.tick(2500); await flush();
  assert.equal(reads, 2);
});

test("a disposed scope aborts delayed results and never schedules again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<number>();
  const accepted: string[] = [];
  let oldSignal: AbortSignal | undefined, oldReads = 0;
  const old = new ReadPoller(async signal => {
    oldSignal = signal; oldReads++;
    const delay = await pending.promise;
    if (!signal.aborted) accepted.push("old");
    return delay;
  }, true);
  const first = old.readOnce();
  old.dispose();
  assert.equal(oldSignal?.aborted, true);
  const current = new ReadPoller(async signal => { if (!signal.aborted) accepted.push("current"); return 2500; }, false);
  t.after(() => current.dispose());
  await current.readOnce();
  pending.resolve(0); await first;
  old.setEnabled(true); await old.readOnce();
  t.mock.timers.tick(10_000); await flush();
  assert.deepEqual(accepted, ["current"]);
  assert.equal(oldReads, 1);
});
