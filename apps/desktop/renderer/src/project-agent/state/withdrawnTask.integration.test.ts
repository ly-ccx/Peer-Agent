import assert from 'node:assert/strict';
import test from 'node:test';
import { readWithdrawnTaskSnapshots } from '../../../../scripts/withdrawn-task-fixture.mjs';
import { readDrawerSession } from './drawerState.ts';
import { backgroundWork, indexBotWork } from './botWorkState.ts';

test('native cancellation and cold recovery remove the withdrawn task from the real consumer count', async () => {
  const snapshots = await readWithdrawnTaskSnapshots();
  for (const rows of Object.values(snapshots)) assert.equal(rows.length, 4, 'get/list/summaries/batch all supply a real host response');
  for (const raw of snapshots.pending) {
    const row = readDrawerSession(raw);
    assert.ok(row);
    assert.equal(backgroundWork(indexBotWork([row], true)).count, 1);
  }
  for (const raw of [...snapshots.withdrawn, ...snapshots.recovered]) {
    const row = readDrawerSession(raw);
    assert.ok(row);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.followUp?.reason, 'user_withdrawn');
    assert.deepEqual(row.withdrawalUnknownCallIds, ['unknown-bash']);
    assert.equal(backgroundWork(indexBotWork([row], true)).count, 0);
  }
});
