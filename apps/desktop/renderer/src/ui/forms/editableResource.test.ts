import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditableResource } from './editableResource.ts';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test('an unconfirmed write retains the draft, and retry uses that draft', async () => {
  let fail = true; const writes: string[] = [];
  const form = createEditableResource<string>('', { read: async () => 'saved', write: async draft => { writes.push(draft); if (fail) throw Error('offline'); return draft.trim(); } });
  await form.load(); form.edit(' edited ');
  assert.equal(await form.save(), false);
  assert.equal(form.snapshot().saved, 'saved'); assert.equal(form.snapshot().draft, ' edited ');
  assert.equal(form.snapshot().saveError, true); assert.equal(form.snapshot().committed, false);
  fail = false; assert.equal(await form.save(), true);
  assert.deepEqual(writes, [' edited ', ' edited ']);
  assert.equal(form.snapshot().draft, 'edited'); assert.equal(form.snapshot().dirty, false);
});
test('late reads cannot overwrite edits or a newer write receipt', async () => {
  const late = deferred<string>(); let reads = 0;
  const form = createEditableResource<string>('', { read: () => ++reads === 1 ? Promise.resolve('saved') : late.promise, write: async draft => draft });
  await form.load(); const read = form.load(); form.edit('next'); await form.save();
  late.resolve('old'); await read;
  assert.equal(form.snapshot().saved, 'next'); assert.equal(form.snapshot().draft, 'next');
});
test('a current read rebases saved state while preserving a dirty draft and stale notice', async () => {
  let saved = 'a'; const form = createEditableResource<string>('', { read: async () => saved, write: async draft => draft });
  await form.load(); form.edit('draft'); saved = 'remote'; await form.load(); await form.load();
  assert.equal(form.snapshot().saved, 'remote'); assert.equal(form.snapshot().draft, 'draft'); assert.equal(form.snapshot().stale, true);
  form.reset(); assert.equal(form.snapshot().draft, 'remote'); assert.equal(form.snapshot().stale, false);
});
test('same-frame submits are serialized, and an edit during save remains unsaved', async () => {
  const receipt = deferred<string>(); let writes = 0;
  const form = createEditableResource<string>('', { read: async () => 'a', write: () => { writes++; return receipt.promise; } });
  await form.load(); form.edit('b'); const first = form.save();
  assert.equal(await form.save(), false); form.edit('c'); receipt.resolve('b');
  assert.equal(await first, false); assert.equal(writes, 1);
  assert.equal(form.snapshot().saved, 'b'); assert.equal(form.snapshot().draft, 'c'); assert.equal(form.snapshot().dirty, true);
});
test('load failure is not an empty success and cannot authorize a settings write', async () => {
  let writes = 0;
  const form = createEditableResource<string>('', { read: async () => { throw Error('read'); }, write: async draft => { writes++; return draft; } });
  assert.equal(await form.load(), false); form.edit('draft'); assert.equal(await form.save(), false);
  assert.equal(form.snapshot().loaded, false); assert.equal(form.snapshot().readError, true); assert.equal(writes, 0);
});
