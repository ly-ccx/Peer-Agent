import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

test('an unsupported future executor or schema cannot recover or mutate the journal',()=>{
  for (const future of [{schemaVersion:2}, {schemaVersion:1,kind:'coordination_decision',transition:{schemaVersion:1,minimumExecutorVersion:2}}]) {
    const env=world();
    try {
      env.store.saveWork({workId:'root',state:'runnable'});
      const file=path.join(env.options.rootDir,'w','coordination.jsonl');
      const bytes=readFileSync(file,'utf8')+JSON.stringify({revision:2,kind:'work',work:{workId:'new'},...future})+'\n';
      writeFileSync(file,bytes);
      const newer=createWorkCoordinationStore(env.options);
      assert.throws(()=>newer.recover(),/coordination_(schema|executor)_unsupported/);
      assert.throws(()=>newer.saveWork({workId:'root',state:'cancelled'}),/coordination_(schema|executor)_unsupported/);
      assert.equal(readFileSync(file,'utf8'),bytes);
    } finally {env.cleanup();}
  }
});
