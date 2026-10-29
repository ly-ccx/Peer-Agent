import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinationRebuildQueue } from './coordination-rebuild-queue.mjs';

test('rebuild slots bound resources, keep FIFO and survive a rejected owner', async () => {
  const run = createCoordinationRebuildQueue(2), started = [], release = [];
  const jobs = Array.from({ length: 6 }, (_, id) => run(async () => {
    started.push(id);
    await new Promise(resolve => { release[id] = resolve; });
    if (id === 1) throw new Error('lease_lost');
    return id;
  }));
  const results = Promise.allSettled(jobs);
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1]);
  release[1](); await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2]);
  for (const id of [0, 2, 3, 4, 5]) { release[id](); await new Promise(setImmediate); }
  const settled = await results;
  assert.equal(settled[1].reason.message, 'lease_lost');
  assert.deepEqual(settled.filter(row => row.status === 'fulfilled').map(row => row.value), [0, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});
