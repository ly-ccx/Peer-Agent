import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createRemoteReceiptStore } from './remote-receipt-store.mjs';

const request = {
  protocolVersion: 1, type: 'task.submit', requestId: 'req-1', ownerId: 'owner-1',
  deviceId: 'device-1', workspaceId: 'ws-1', bindingVersion: 1, connectionEpoch: 1,
  delegationVersion: 1, expiresAt: 20_000, operation: 'task.read', taskId: 'task-1',
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-receipt-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return () => {
    const store = createRemoteReceiptStore(join(dir, 'receipts.sqlite'));
    stores.push(store);
    return store;
  };
}

for (const fault of ['duplicate', 'ack-lost', 'reopen']) {
  for (const phase of ['accepted', 'started', 'succeeded']) {
    test(`receipt-${fault}-${phase}`, t => {
      const open = fixture(t);
      const first = open();
      const accepted = first.accept(request, 10_000);
      assert.equal(accepted.duplicate, false);
      if (phase !== 'accepted') assert.equal(first.claim(request), true);
      if (phase === 'succeeded') assert.equal(first.finish(request, 'succeeded', 'test-evidence://result-1'), true);
      const receiver = fault === 'reopen' ? open() : first;
      const replay = receiver.accept({ ...request, connectionEpoch: 2 }, 21_000);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.receipt.receiptId, accepted.receipt.receiptId);
      assert.equal(replay.receipt.state, phase);
      if (phase !== 'accepted') assert.equal(receiver.claim(request), false, 'never redispatch started or terminal receipts');
      assert.equal(receiver.lookup(request).state, phase);
    });
  }
}

for (const phase of ['accepted', 'started', 'succeeded']) {
  test(`receipt-process-kill-${phase}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-receipt-process-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'receipts.sqlite');
    const moduleUrl = new URL('./remote-receipt-store.mjs', import.meta.url).href;
    const prelude = `import { createRemoteReceiptStore } from ${JSON.stringify(moduleUrl)};
      const store = createRemoteReceiptStore(${JSON.stringify(path)});
      const request = ${JSON.stringify(request)};`;
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `${prelude}
      store.accept(request, 10000);
      if (${JSON.stringify(phase)} !== 'accepted') store.claim(request);
      if (${JSON.stringify(phase)} === 'succeeded') store.finish(request, 'succeeded', 'test-evidence://child');
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(writer.error);
    assert.equal(writer.signal, 'SIGKILL', writer.stderr);
    const reader = spawnSync(process.execPath, ['--input-type=module', '-e', `${prelude}
      const row = store.lookup(request);
      const replay = store.accept(request, 21000);
      const claimed = store.claim(request);
      console.log(JSON.stringify({ row, replay, claimed }));
      store.close();
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(reader.error);
    assert.equal(reader.status, 0, reader.stderr);
    const result = JSON.parse(reader.stdout);
    assert.equal(result.row.state, phase);
    assert.equal(result.replay.duplicate, true);
    assert.equal(result.replay.receipt.receiptId, result.row.receiptId);
    assert.equal(result.claimed, phase === 'accepted');
    assert.equal(result.row.evidenceRef, phase === 'succeeded' ? 'test-evidence://child' : null);
  });
}

test('two database handles contend for one receipt and only one execution claim', t => {
  const open = fixture(t); const a = open(); const b = open();
  assert.equal(a.accept(request, 10_000).duplicate, false);
  assert.equal(b.accept(request, 10_000).duplicate, true);
  assert.equal(a.claim(request), true);
  assert.equal(b.claim(request), false);
});

test('changed logical body conflicts; owner and device scopes never alias', t => {
  const store = fixture(t)();
  store.accept(request, 10_000);
  for (const patch of [{ taskId: 'other' }, { workspaceId: 'other' }, { delegationVersion: 2 }]) {
    assert.throws(() => store.accept({ ...request, ...patch }, 10_000), /REQUEST_CONFLICT/);
    assert.throws(() => store.lookup({ ...request, ...patch }), /REQUEST_CONFLICT/);
    assert.equal(store.claim({ ...request, ...patch }), false);
  }
  assert.equal(store.lookup({ ...request, ownerId: 'other' }), null);
  assert.equal(store.lookup({ ...request, deviceId: 'other' }), null);
  assert.equal(store.lookup(request).state, 'accepted', 'failed transactions rolled back');
});

test('new expired requests are not stored and terminal transitions require evidence', t => {
  const store = fixture(t)();
  assert.throws(() => store.accept(request, 20_000), /REQUEST_EXPIRED/);
  assert.equal(store.lookup(request), null);
  store.accept(request, 10_000);
  assert.equal(store.finish(request, 'succeeded', 'test-evidence://result'), false);
  store.claim(request);
  assert.throws(() => store.finish(request, 'succeeded', ''), /evidence/);
  assert.equal(store.finish(request, 'failed', 'test-evidence://failure'), true);
  assert.equal(store.finish(request, 'succeeded', 'test-evidence://replacement'), false);
  assert.equal(store.lookup(request).evidenceRef, 'test-evidence://failure');
});
