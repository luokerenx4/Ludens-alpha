import test from "node:test";
import assert from "node:assert/strict";
import { createPerceptionSession, normalizePerceptionDraft, perceptionPatch, perceptionReloadCommand, type SavedPerception } from "../components/perception-draft";

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("raw invalid and incomplete input survives reload without numeric coercion", async () => {
  for (const raw of ["", "abc", "0x258", "6e2", "-1", "600.", "600.5"]) {
    const disk = storage();
    const first = createPerceptionSession({ scope: "alpha:/one", storage: disk, read: async () => ({ hotSeconds: 600 }), write: async () => { throw Error("not called"); } });
    await first.refresh(); first.edit("hotSeconds", "override", raw);
    const restored = createPerceptionSession({ scope: "alpha:/one", storage: disk, read: async () => ({ hotSeconds: 600 }), write: async () => { throw Error("not called"); } });
    await restored.refresh();
    assert.equal(restored.snapshot().draft.hotSeconds?.raw, raw);
    assert.deepEqual(perceptionPatch(restored.snapshot().draft).invalid, ["hotSeconds"]);
    assert.equal(await restored.save(), false);
  }
});

test("custom saved values stay untouched and do not block another field's patch", async () => {
  let patch;
  const s = createPerceptionSession({ scope: "a", read: async () => ({ hotSeconds: .5, videoSegmentSeconds: 7200 }), write: async value => {
    patch = value; return { hotSeconds: .5, videoSegmentSeconds: 7200, videoIdleSeconds: 12 };
  } });
  await s.refresh(); s.edit("videoIdleSeconds", "override", "12"); assert.equal(await s.save(), true);
  assert.deepEqual(patch, { videoIdleSeconds: 12 }); assert.deepEqual(s.snapshot().settings, { hotSeconds: .5, videoSegmentSeconds: 7200, videoIdleSeconds: 12 });
  assert.deepEqual(normalizePerceptionDraft({ hotSeconds: { mode: "override", raw: "0.5" } }, { hotSeconds: .5 }), {});
});

test("fresh GET rebases matching edits, retains other raw drafts and their original comparison base", async () => {
  let values = { hotSeconds: 600, videoSegmentSeconds: 300 };
  const s = createPerceptionSession({ scope: "a", read: async () => values, write: async () => values });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); s.edit("videoSegmentSeconds", "override", "invalid");
  values = { hotSeconds: 900, videoSegmentSeconds: 400 }; await s.refresh();
  assert.equal(s.snapshot().draft.hotSeconds, undefined); assert.equal(s.snapshot().draft.videoSegmentSeconds?.raw, "invalid");
  assert.equal(s.snapshot().draft.videoSegmentSeconds?.base, 300); assert.equal(s.snapshot().settings?.videoSegmentSeconds, 400);
  s.discard(); assert.deepEqual(s.snapshot().draft, {}); assert.deepEqual(s.snapshot().settings, values);
});

test("inheritance is null in the patch and clearing an already inherited field is clean", async () => {
  let patch;
  const s = createPerceptionSession({ scope: "a", read: async () => ({ hotSeconds: 600 }), write: async value => { patch = value; return {}; } });
  await s.refresh(); s.edit("videoIdleSeconds", "inherit", "10"); assert.deepEqual(s.snapshot().draft, {});
  s.edit("hotSeconds", "inherit", "600"); assert.deepEqual(perceptionPatch(s.snapshot().draft).patch, { hotSeconds: null });
  await s.save(); assert.deepEqual(patch, { hotSeconds: null }); assert.deepEqual(s.snapshot().draft, {});
});

test("scope buckets isolate workspaces and paths; a save completes after every UI subscriber leaves", async () => {
  const disk = storage(), pending = deferred<SavedPerception>();
  const a = createPerceptionSession({ scope: "id:/first", storage: disk, read: async () => ({ hotSeconds: 600 }), write: async () => pending.promise });
  const b = createPerceptionSession({ scope: "id:/second", storage: disk, read: async () => ({ hotSeconds: 60 }), write: async () => ({ hotSeconds: 60 }) });
  await a.refresh(); await b.refresh(); a.edit("hotSeconds", "override", "900");
  let updates = 0; const off = a.subscribe(() => updates++); const saving = a.save(); off(); const before = updates;
  pending.resolve({ hotSeconds: 900 }); await saving;
  assert.equal(updates, before); assert.equal(a.snapshot().writeState, "saved"); assert.equal(b.snapshot().settings?.hotSeconds, 60);
  const restored = createPerceptionSession({ scope: "id:/first", storage: disk, read: async () => ({ hotSeconds: 900 }), write: async () => ({}) });
  assert.equal(restored.snapshot().settings?.hotSeconds, 900); assert.deepEqual(restored.snapshot().draft, {});
});

test("save invalidates late reads and guards duplicate save/read/discard/edit synchronously", async () => {
  let reads = 0, writes = 0; const stale = deferred<SavedPerception>(), pending = deferred<SavedPerception>();
  const s = createPerceptionSession({ scope: "a", read: async () => ++reads === 1 ? { hotSeconds: 600 } : stale.promise,
    write: async () => { writes++; return pending.promise; } });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); const reading = s.refresh(); const revision = s.snapshot().settingsRevision; const saving = s.save();
  assert.equal(s.snapshot().settingsRevision, revision + 1, "Runtime observations invalidate when writing begins, before a response exists");
  assert.equal(await s.save(), false); await s.refresh(); s.discard(); s.edit("hotSeconds", "override", "1000");
  assert.equal(s.snapshot().draft.hotSeconds?.raw, "900"); assert.equal(reads, 2); assert.equal(writes, 1);
  pending.resolve({ hotSeconds: 900 }); await saving; stale.resolve({ hotSeconds: 600 }); await reading;
  assert.equal(s.snapshot().settings?.hotSeconds, 900); assert.equal(s.snapshot().writeState, "saved");
});

test("uncertain writes never replay, and matching GET confirms current values without claiming request success", async () => {
  let reads = 0, writes = 0;
  const s = createPerceptionSession({ scope: "a", read: async () => ({ hotSeconds: ++reads === 1 ? 600 : 900 }),
    write: async () => { writes++; throw Error("response lost after commit"); } });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); assert.equal(await s.save(), false);
  assert.equal(s.snapshot().writeState, "unconfirmed"); assert.equal(await s.save(), false); assert.equal(writes, 1);
  assert.equal(s.snapshot().settingsRevision, 2, "Uncertainty cannot revive the pre-save runtime observation");
  await s.refresh(); assert.equal(s.snapshot().writeState, "matched"); assert.deepEqual(s.snapshot().draft, {}); assert.equal(writes, 1);
});

test("a nonmatching read resolves uncertainty into review, preserving newer edits before explicit save", async () => {
  let values = { hotSeconds: 600 }, writes = 0;
  const s = createPerceptionSession({ scope: "a", read: async () => values, write: async patch => {
    if (++writes === 1) throw Error("unconfirmed"); values = { hotSeconds: patch.hotSeconds as number }; return values;
  } });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); await s.save(); s.edit("hotSeconds", "override", "1000");
  await s.refresh(); assert.equal(s.snapshot().writeState, "review"); assert.equal(s.snapshot().draft.hotSeconds?.raw, "1000");
  assert.equal(writes, 1); assert.equal(await s.save(), true); assert.equal(writes, 2); assert.equal(s.snapshot().settings?.hotSeconds, 1000);
});

test("a reload of a pending write reads back the scope but never resubmits it", async () => {
  const disk = storage(), pending = deferred<SavedPerception>(); let writes = 0;
  const s = createPerceptionSession({ scope: "a", storage: disk, read: async () => ({ hotSeconds: 600 }), write: async () => { writes++; return pending.promise; } });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); const original = s.save(); await tick();
  const reloaded = createPerceptionSession({ scope: "a", storage: disk, read: async () => ({ hotSeconds: 900 }), write: async () => { writes++; return {}; } });
  assert.equal(reloaded.snapshot().writeState, "unconfirmed"); assert.equal(await reloaded.save(), false);
  await reloaded.refresh(); assert.equal(reloaded.snapshot().writeState, "matched"); assert.equal(writes, 1);
  pending.resolve({ hotSeconds: 900 }); await original;
});

test("failed reads retain cached values, invalid drafts, and uncertainty until a successful GET", async () => {
  let fail = false; const s = createPerceptionSession({ scope: "a", read: async () => { if (fail) throw Error("read offline"); return { hotSeconds: 600 }; }, write: async () => { throw Error("write offline"); } });
  await s.refresh(); s.edit("hotSeconds", "override", "900"); await s.save(); s.edit("hotSeconds", "override", ""); fail = true; await s.refresh();
  assert.equal(s.snapshot().settings?.hotSeconds, 600); assert.equal(s.snapshot().draft.hotSeconds?.raw, "");
  assert.equal(s.snapshot().writeState, "unconfirmed"); assert.equal(s.snapshot().readError, "read offline");
});

test("storage failure degrades to memory without losing live edits, and corrupt storage does not crash", async () => {
  let blocked = false; const disk = storage(), storageWithFailure = { getItem: disk.getItem, setItem(key: string, value: string) { if (blocked) throw Error("quota"); disk.setItem(key, value); } };
  const s = createPerceptionSession({ scope: "a", storage: storageWithFailure, read: async () => ({}), write: async () => ({}) });
  await s.refresh(); blocked = true; s.edit("hotSeconds", "override", "invalid");
  assert.equal(s.snapshot().persistence, "memory"); assert.equal(s.snapshot().draft.hotSeconds?.raw, "invalid");
  const corrupt = createPerceptionSession({ scope: "broken", storage: { getItem: () => "{", setItem() {} }, read: async () => ({}), write: async () => ({}) });
  await corrupt.refresh(); assert.deepEqual(corrupt.snapshot().settings, {}); assert.equal(corrupt.snapshot().persistence, "memory");
});

test("reload command removes inherited socket override and quotes the exact workspace path", () => {
  assert.equal(perceptionReloadCommand("/tmp/a'b $(touch unsafe)"), "env -u RSA_SOCKET rsa --workspace '/tmp/a'\\''b $(touch unsafe)' perception reload");
});
