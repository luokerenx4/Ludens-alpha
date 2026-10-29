import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopResource, DesktopResourceCancelled, type DesktopResourceState } from '../components/pet-resource';
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture<T>(read: () => Promise<T>, timeoutMs = 1000) {
  const values: DesktopResourceState<T>[] = [];
  let live = true, listener: (value: T) => void = () => {}, off = 0;
  const resource = createDesktopResource({ read, timeoutMs, isCurrent: () => live,
    subscribe(callback) { listener = callback; return () => { off++ } }, onChange: value => values.push(value) });
  return { resource, values, emit: (value: T) => listener(value), disconnect: () => { live = false }, off: () => off };
}

test('unknown values stay null; cached read failure preserves the known value and retry only reads', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 2) throw Error('offline'); return { volume: calls === 1 ? .2 : .4 } });
  try {
    assert.equal(f.resource.snapshot().value, null); await f.resource.retry(); await f.resource.retry();
    assert.deepEqual(f.resource.snapshot().value, { volume: .2 }); assert.equal(f.resource.snapshot().readError, 'offline');
    await f.resource.retry(); assert.deepEqual(f.resource.snapshot().value, { volume: .4 });
    assert.equal(f.resource.snapshot().readError, null); assert.equal(calls, 3);
  } finally { f.resource.dispose() }
});
for (const fail of [false, true]) test(`a notification supersedes an in-flight initial read ${fail ? 'failure' : 'result'}`, async () => {
  const pending = deferred<number>(), f = fixture(() => pending.promise);
  try {
    const reading = f.resource.retry(); await tick(); f.emit(7);
    if (fail) pending.reject(Error('old failure')); else pending.resolve(1);
    await reading; assert.equal(f.resource.snapshot().value, 7); assert.equal(f.resource.snapshot().loading, false); assert.equal(f.resource.snapshot().readError, null);
  } finally { f.resource.dispose() }
});
test('a synchronous subscription snapshot supersedes an older getter snapshot', async () => {
  const resource = createDesktopResource({ read: async () => 1, subscribe(callback: (value: number) => void) { callback(9); return () => {} }, isCurrent: () => true, onChange() {} });
  try { await resource.retry(); assert.equal(resource.snapshot().value, 9) } finally { resource.dispose() }
});
test('a notification supersedes delayed write; duplicate writes and reads are blocked while pending', async () => {
  let reads = 0, writes = 0; const pending = deferred<number>(), f = fixture(async () => { reads++; return 1 });
  try {
    await f.resource.retry(); const writing = f.resource.write(async () => { writes++; return pending.promise }); await tick();
    assert.equal(await f.resource.write(async () => { writes++; return 12 }), false); await f.resource.retry(); assert.equal(reads, 1);
    f.emit(9); pending.resolve(2); assert.equal(await writing, true);
    assert.equal(f.resource.snapshot().value, 9); assert.equal(f.resource.snapshot().pending, false); assert.equal(writes, 1);
  } finally { f.resource.dispose() }
});
test('a write invalidates preceding cached GET and accepts false as a known value', async () => {
  const pending = deferred<boolean>(); let reads = 0; const f = fixture(async () => ++reads === 1 ? false : pending.promise);
  try {
    await f.resource.retry(); const reading = f.resource.retry(); await tick(); assert.equal(await f.resource.write(async () => true), true);
    pending.resolve(false); await reading; assert.equal(f.resource.snapshot().value, true); assert.equal(f.resource.snapshot().loading, false);
  } finally { f.resource.dispose() }
});
test('disconnect and disposal discard late values, notifications and pending writes', async () => {
  const pending = deferred<number>(), f = fixture(async () => 1);
  await f.resource.retry(); const writing = f.resource.write(async () => pending.promise); await tick();
  const before = f.values.length; f.disconnect(); f.emit(8); pending.resolve(2); await writing;
  assert.equal(f.values.length, before); assert.equal(f.resource.snapshot().value, 1); f.resource.dispose(); assert.equal(f.off(), 1);
  const next = fixture(async () => 4); try { assert.equal(next.resource.snapshot().value, null); await next.resource.retry(); assert.equal(next.resource.snapshot().value, 4) } finally { next.resource.dispose() }
});
test('a read timeout can retry and its late response cannot replace the new result', async () => {
  const pending = deferred<number>(); let reads = 0; const f = fixture(async () => ++reads === 1 ? pending.promise : 5, 10);
  try {
    await f.resource.retry(); assert.match(f.resource.snapshot().readError ?? '', /timed out/); await f.resource.retry(); pending.resolve(1); await tick();
    assert.equal(f.resource.snapshot().value, 5); assert.equal(f.resource.snapshot().readError, null);
  } finally { f.resource.dispose() }
});
test('unconfirmed write is never replayed and needs successful read before another change', async () => {
  const pending = deferred<number>(); let writes = 0; const f = fixture(async () => 5, 10);
  try {
    await f.resource.retry(); assert.equal(await f.resource.write(async () => { writes++; return pending.promise }), false);
    assert.equal(f.resource.snapshot().writeError?.code, 'unconfirmed'); assert.equal(await f.resource.write(async () => { writes++; return 7 }), false); assert.equal(writes, 1);
    await f.resource.retry(); assert.equal(f.resource.snapshot().writeError, null); pending.resolve(2); await tick(); assert.equal(f.resource.snapshot().value, 5);
    assert.equal(await f.resource.write(async () => { writes++; return 7 }), true); assert.equal(writes, 2);
  } finally { f.resource.dispose() }
});
test('an import-like validation continuation cannot dispatch after disposal', async () => {
  const validation = deferred<void>(), f = fixture(async () => 1); let writes = 0;
  await f.resource.retry(); const writing = f.resource.write(async stillCurrent => { await validation.promise; if (!stillCurrent()) throw new DesktopResourceCancelled(); writes++; return 2 });
  await tick(); f.resource.dispose(); validation.resolve(); await writing; await tick(); assert.equal(writes, 0);
});
test('validation errors do not require an IPC read before choosing a valid file', async () => {
  const f = fixture(async () => 1);
  try {
    await f.resource.retry(); await f.resource.write(async () => { throw Error('invalidFile') }); assert.equal(f.resource.snapshot().writeError?.code, 'invalidFile');
    assert.equal(await f.resource.write(async () => 2), true); assert.equal(f.resource.snapshot().value, 2);
  } finally { f.resource.dispose() }
});
