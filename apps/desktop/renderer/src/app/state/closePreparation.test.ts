import assert from 'node:assert/strict';
import test from 'node:test';
import { createClosePreparation } from './closePreparation.ts';

function deferred() {
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a live editor closes only after a successful preparation receipt', async () => {
  const gate = createClosePreparation(), saving = deferred(); let closed = 0;
  gate.request(() => saving.promise, () => closed++);
  assert.equal(closed, 0);
  saving.resolve(true); await saving.promise;
  assert.equal(closed, 1);
});

test('repeated close requests share the pending save instead of starting another', async () => {
  const gate = createClosePreparation(), saving = deferred(); let prepares = 0, closed = 0;
  const prepare = () => { prepares++; return saving.promise; };
  gate.request(prepare, () => closed++); gate.request(prepare, () => closed++);
  assert.equal(prepares, 1);
  saving.resolve(true); await saving.promise;
  assert.equal(closed, 1);
});

test('false, thrown and rejected preparations leave recovery in the editor', async () => {
  const gate = createClosePreparation(), saving = deferred(); let closed = 0;
  gate.request(() => false, () => closed++);
  gate.request(() => { throw Error('save'); }, () => closed++);
  gate.request(() => saving.promise, () => closed++);
  saving.reject(Error('offline')); await saving.promise.catch(() => {});
  assert.equal(closed, 0);
  gate.request(() => true, () => closed++);
  assert.equal(closed, 1);
});

test('an old unmounted editor cannot dismiss or unlock the next editor', async () => {
  const gate = createClosePreparation(), old = deferred(), current = deferred(); let closed = '';
  gate.request(() => old.promise, () => { closed += 'old'; });
  gate.cancel();
  gate.request(() => current.promise, () => { closed += 'current'; });
  old.resolve(true); await old.promise;
  gate.request(() => true, () => { closed += 'duplicate'; });
  assert.equal(closed, '');
  current.resolve(true); await current.promise;
  assert.equal(closed, 'current');
});
