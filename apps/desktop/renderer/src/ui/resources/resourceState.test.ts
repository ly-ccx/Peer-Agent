import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceActions, createResourceReader } from './resourceState.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a failed read is distinct from a confirmed empty list and preserves prior facts', async () => {
  let fail = true;
  const reader = createResourceReader(async () => { if (fail) throw Error('offline'); return ['record']; });
  await reader.reload();
  assert.equal(reader.snapshot().loaded, false);
  assert.equal(reader.snapshot().error, true);
  fail = false; await reader.reload(); fail = true; await reader.reload();
  assert.deepEqual(reader.snapshot().value, ['record']);
  assert.equal(reader.snapshot().loaded, true);
  assert.equal(reader.snapshot().error, true);
});

test('late reads and cancelled scopes cannot replace a newer read or a host write receipt', async () => {
  const first = deferred<string>(), second = deferred<string>();
  let calls = 0;
  const reader = createResourceReader(() => ++calls === 1 ? first.promise : second.promise);
  const a = reader.reload(), b = reader.reload();
  second.resolve('new'); await b; first.resolve('old'); await a;
  assert.equal(reader.snapshot().value, 'new');
  const late = deferred<string>();
  const cancelled = createResourceReader(() => late.promise);
  const task = cancelled.reload(); cancelled.cancel(); late.resolve('wrong workspace'); await task;
  assert.equal(cancelled.snapshot().value, null);
  assert.equal(cancelled.snapshot().loading, false);
  const pending = reader.reload(); reader.accept('host receipt'); await pending;
  assert.equal(reader.snapshot().value, 'host receipt');
});

test('actions lock synchronously by object, never replay failures, and separate write receipts from refresh failures', async () => {
  const actions = createResourceActions(), receipt = deferred<void>();
  let writes = 0;
  const first = actions.run('one', async () => { writes++; await receipt.promise; });
  assert.equal(await actions.run('one', async () => { writes++; }), false);
  assert.equal(await actions.run('two', async () => {}), true);
  receipt.resolve(); assert.equal(await first, true); assert.equal(writes, 1);
  const reader = createResourceReader(async () => { throw Error('refresh unavailable'); });
  await reader.reload();
  assert.equal(actions.snapshot().one.confirmed, true);
  assert.equal(reader.snapshot().error, true);
  await actions.run('one', async () => { writes++; throw Error('unknown result'); });
  assert.equal(writes, 2);
  assert.deepEqual(actions.snapshot().one, { pending: false, confirmed: false, error: true });
});


test('a cancelled native action has no success or failure claim', async () => {
  const actions = createResourceActions();
  assert.equal(await actions.run('export', async () => false), false);
  assert.deepEqual(actions.snapshot().export, { pending: false, confirmed: false, error: false, cancelled: true });
});
