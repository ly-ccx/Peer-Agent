import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageRequestOrder } from './accountUsageRequestOrder.ts';
import { observeAccountUsageRequest } from './accountUsageRequest.ts';

for (const rejects of [false, true]) test(`order/same-channel/old-rejects-${rejects}`, async () => {
  const order = createAccountUsageRequestOrder();
  const old = order.begin('a');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let published = 0;
  const work = observeAccountUsageRequest(async () => {
    await gate;
    if (rejects) throw new Error('old');
    return { success: true };
  }, old.current, () => { published++; }, () => { published++; });
  const latest = order.begin('a');
  release();
  await work;
  assert.equal(published, 0);
  assert.equal(old.finish(), false);
  assert.equal(latest.current(), true);
  assert.equal(latest.finish(), true);
  assert.equal(latest.finish(), false);
});
test('order/different-channels/results-independent/loading-owned-by-newest', () => {
  const order = createAccountUsageRequestOrder();
  const a = order.begin('a');
  const b = order.begin('b');
  assert.equal(a.current(), true);
  assert.equal(b.current(), true);
  assert.equal(a.finish(), false);
  assert.equal(b.finish(), true);
});
test('order/cancelled-request/releases-loading-without-publication', async () => {
  const ticket = createAccountUsageRequestOrder().begin('a');
  await observeAccountUsageRequest(async () => ({ success: true }), () => false,
    () => assert.fail('cancelled'), () => assert.fail('cancelled'));
  assert.equal(ticket.finish(), true);
});
