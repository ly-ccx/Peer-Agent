import assert from 'node:assert/strict';
import test from 'node:test';
import { withFileMutationLock } from './file-mutation-lock.mjs';
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test('same host path serializes, unrelated paths proceed, and an error releases the queue', async () => {
  const hold = deferred(), events = [];
  const first = withFileMutationLock('/fixture/one', async () => { events.push('first'); await hold.promise; throw Error('failure'); }); const error = assert.rejects(first, /failure/);
  const second = withFileMutationLock('/fixture/one', () => events.push('second'));
  await withFileMutationLock('/fixture/two', () => events.push('other')); assert.deepEqual(events, ['first', 'other']);
  hold.resolve(); await Promise.all([error, second]); assert.deepEqual(events, ['first', 'other', 'second']);
});
test('cancelled queued caller returns promptly but cannot unlock another live writer or run later', async () => {
  const hold = deferred(), stop = new AbortController(); let called = false, later = false;
  const first = withFileMutationLock('/fixture/cancel', () => hold.promise);
  const cancelled = withFileMutationLock('/fixture/cancel', () => { called = true; }, { signal: stop.signal }); const failure = assert.rejects(cancelled, { code: 'FILE_MUTATION_CANCELLED' });
  stop.abort(); await failure;
  const third = withFileMutationLock('/fixture/cancel', () => { later = true; }); await tick(); assert.equal(later, false);
  hold.resolve(); await Promise.all([first, third]); assert.equal(called, false); assert.equal(later, true);
});
