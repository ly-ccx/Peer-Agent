import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAccountUsageRequest } from './accountUsageRequest.ts';

for (const cancelled of [false, true]) {
  for (const rejects of [false, true]) test(`request/cancelled-${cancelled}/rejects-${rejects}`, async () => {
    let active = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let successes = 0;
    let failures = 0;
    const work = observeAccountUsageRequest(async () => {
      await gate;
      if (rejects) throw new Error('private');
      return { success: true };
    }, () => active, () => { successes++; }, () => { failures++; });
    active = !cancelled;
    release();
    await work;
    assert.equal(successes, !cancelled && !rejects ? 1 : 0);
    assert.equal(failures, !cancelled && rejects ? 1 : 0);
  });
}
test('request/already-cancelled/no-request', async () => {
  await observeAccountUsageRequest(() => { assert.fail('must not request'); }, () => false,
    () => assert.fail('must not publish'), () => assert.fail('must not publish'));
});
