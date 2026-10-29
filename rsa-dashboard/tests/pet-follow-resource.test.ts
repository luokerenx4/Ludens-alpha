import { test } from "node:test";
import assert from "node:assert/strict";
import { createPetFollowResource } from "../components/pet-follow-resource";
import type { PetState, PetTarget, PetTargetReceipt } from "../lib/pet";

const target = (project: string): PetTarget => ({ project, workspace: "/" + project, revision: project, updatedAt: "2026-10-30T00:00:00Z" });
const state = (project: string | null): PetState => ({ target: project ? target(project) : null, targetConfigured: true, consumer: null, connected: false });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function resource(read: (signal: AbortSignal) => Promise<PetState>, write: (project: string | null, signal: AbortSignal) => Promise<PetTargetReceipt>, timeoutMs = 1000) {
  return createPetFollowResource({ read, write, onChange() {}, intervalMs: 60_000, timeoutMs });
}

test("a committed receipt survives the independent read failure without repeating a write", async () => {
  let reads = 0, writes = 0;
  const r = resource(async () => { if (++reads > 1) throw Error("status offline"); return state("alpha"); }, async () => { writes++; return { target: target("beta") }; });
  try {
    await r.refresh(); await r.follow("beta"); await flush();
    assert.equal(r.snapshot().state?.target?.project, "beta");
    assert.equal(r.snapshot().lastSaved?.project, "beta");
    assert.equal(r.snapshot().state?.connected, null);
    assert.equal(r.snapshot().writeError, "");
    assert.equal(r.snapshot().readError, "status offline");
    await r.refresh(); assert.equal(writes, 1); assert.equal(reads, 3);
  } finally { r.dispose(); }
});

test("consumer-only failure retains an authoritative target and does not prevent a new selection", async () => {
  const r = resource(async () => ({ ...state("alpha"), connected: null, consumerError: "bad heartbeat" }), async () => ({ target: null }));
  try { await r.refresh(); assert.equal(r.snapshot().canWrite, true); assert.equal(r.snapshot().state?.connected, null); assert.equal(r.snapshot().readError, ""); }
  finally { r.dispose(); }
});

test("an uncertain write keeps its intended target across read failure and blocks duplicate changes", async () => {
  let reads = 0, writes = 0;
  const r = resource(async () => { reads++; if (reads === 2) throw Error("read offline"); return state(reads > 2 ? "beta" : "alpha"); }, async () => { writes++; throw Error("response lost"); });
  try {
    await r.refresh(); await r.follow("beta");
    assert.equal(reads, 1, "a missing write response does not start recovery implicitly");
    await r.follow("gamma"); assert.equal(writes, 1);
    assert.equal(r.snapshot().requested, "beta"); assert.equal(r.snapshot().state?.target?.project, "alpha");
    await r.refresh(); assert.equal(r.snapshot().writeError, "response lost"); assert.equal(r.snapshot().readError, "read offline");
    assert.equal(r.snapshot().canWrite, false); assert.equal(r.snapshot().requested, "beta");
    await r.refresh(); assert.equal(r.snapshot().state?.target?.project, "beta");
    assert.equal(r.snapshot().writeError, ""); assert.equal(r.snapshot().requested, undefined); assert.equal(r.snapshot().canWrite, true);
    assert.equal(writes, 1);
  } finally { r.dispose(); }
});

test("a superseded GET cannot replace the saved receipt even if transport ignores cancellation", async () => {
  const old = deferred<PetState>(); let reads = 0; let signal: AbortSignal | undefined;
  const r = resource(async next => { if (++reads === 1) return state("alpha"); if (reads === 2) { signal = next; return old.promise; } throw Error("new read failed"); }, async () => ({ target: target("beta") }));
  try {
    await r.refresh(); const pending = r.refresh(); await flush();
    await r.follow("beta"); assert.equal(signal?.aborted, true);
    old.resolve(state("alpha")); await pending; await flush();
    assert.equal(r.snapshot().state?.target?.project, "beta"); assert.equal(r.snapshot().lastSaved?.project, "beta");
  } finally { r.dispose(); }
});

test("pending writes are single flight and keep their requested stop distinct from the last target", async () => {
  const receipt = deferred<PetTargetReceipt>(); let writes = 0, reads = 0;
  const r = resource(async () => { reads++; return state(null); }, async () => { writes++; return receipt.promise; });
  try {
    await r.refresh(); const pending = r.follow(null); await flush();
    assert.equal(r.snapshot().pending, true); assert.equal(r.snapshot().requested, null);
    await r.follow("beta"); await r.refresh(); assert.equal(writes, 1); assert.equal(reads, 1);
    receipt.resolve({ target: null }); await pending; await flush();
    assert.equal(r.snapshot().pending, false); assert.equal(r.snapshot().state?.target, null); assert.equal(reads, 2);
  } finally { r.dispose(); }
});

test("unknown and failed reads never become an editable empty target", async () => {
  let writes = 0;
  const r = resource(async () => { throw Error("catalog unavailable"); }, async () => { writes++; return { target: null }; });
  try { await r.follow("alpha"); await r.refresh(); await r.follow("alpha"); assert.equal(writes, 0); assert.equal(r.snapshot().state, null); assert.equal(r.snapshot().canWrite, false); }
  finally { r.dispose(); }
});

test("a timed out PUT remains unconfirmed even when its ignored late response eventually arrives", async () => {
  const receipt = deferred<PetTargetReceipt>(); let writes = 0;
  const r = resource(async () => state("alpha"), async () => { writes++; return receipt.promise; }, 15);
  try {
    await r.refresh(); await r.follow("beta");
    assert.match(r.snapshot().writeError, /timed out/); assert.equal(r.snapshot().pending, false);
    receipt.resolve({ target: target("beta") }); await flush();
    assert.equal(r.snapshot().state?.target?.project, "alpha"); assert.equal(r.snapshot().requested, "beta"); assert.equal(writes, 1);
  } finally { r.dispose(); }
});

test("disposing aborts operations and prevents late results from updating a replacement owner", async () => {
  const receipt = deferred<PetTargetReceipt>(); const observed: unknown[] = []; let signal: AbortSignal | undefined;
  const r = createPetFollowResource({ read: async () => state("alpha"), write: async (_project, next) => { signal = next; return receipt.promise; }, onChange: snapshot => observed.push(snapshot), intervalMs: 60_000 });
  await r.refresh(); const pending = r.follow("beta"); await flush(); r.dispose(); const count = observed.length;
  assert.equal(signal?.aborted, true); receipt.resolve({ target: target("beta") }); await pending; await flush();
  assert.equal(observed.length, count);
});
