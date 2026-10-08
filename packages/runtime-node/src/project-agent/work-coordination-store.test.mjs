import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createReplyDelivery } from './reply-delivery.mjs';

function world() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'r88-coordination-'));
  let epoch = 'first';
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => epoch };
  return { options, store: createWorkCoordinationStore(options), replace: () => { epoch = 'second'; },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}
test('transfer persists before handling; priority handling leaves the earlier event recoverable', () => {
  const env = world();
  try {
    env.store.transfer([{ eventId: 'slow', seq: 1 }, { eventId: 'result', seq: 2 }]);
    env.store.handled(['result']);
    const recovered = createWorkCoordinationStore(env.options);
    assert.deepEqual(recovered.pendingEvents().map(row => row.eventId), ['slow']);
    recovered.transfer([{ eventId: 'result', seq: 2 }]);
    assert.equal(Object.keys(recovered.read().events).length, 2);
    env.replace();
    assert.throws(() => env.store.handled(['slow']), /lease_lost/);
  } finally { env.cleanup(); }
});
test('restart after reply append and failed acceptance only retries acceptance', async () => {
  const env = world(); const messages = []; let attempts = 0;
  const ports = { readMessages: () => messages, appendMessage: msg => messages.push(msg),
    accept: () => { if (++attempts === 1) throw new Error('disk unavailable'); } };
  try {
    const message = { id: 'stable', content: 'done' };
    await assert.rejects(createReplyDelivery({ store: env.store, ...ports }).deliver(message), /disk unavailable/);
    assert.equal(messages.length, 1);
    await createReplyDelivery({ store: createWorkCoordinationStore(env.options), ...ports }).recover();
    assert.equal(messages.length, 1); assert.equal(attempts, 2);
    assert.equal(env.store.read().deliveries.stable.state, 'delivered');
    await createReplyDelivery({ store: env.store, ...ports }).recover();
    assert.equal(attempts, 2);
  } finally { env.cleanup(); }
});
