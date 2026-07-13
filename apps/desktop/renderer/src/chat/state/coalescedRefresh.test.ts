import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoalescedRefreshScheduler } from './coalescedRefresh.ts';

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('coalesces repeated refresh signals before work starts', async () => {
  let calls = 0;
  const scheduler = createCoalescedRefreshScheduler(async () => { calls += 1; }, 5);

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  await wait(20);

  assert.equal(calls, 1);
  scheduler.dispose();
});

test('never overlaps refreshes and runs one queued follow-up', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | undefined;
  const firstRefresh = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const scheduler = createCoalescedRefreshScheduler(async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await firstRefresh;
    active -= 1;
  }, 5);

  scheduler.schedule(0);
  await wait(5);
  scheduler.schedule(0);
  scheduler.schedule(0);
  await wait(5);
  assert.equal(calls, 1);

  releaseFirst?.();
  await wait(20);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  scheduler.dispose();
});

test('dispose cancels pending refreshes', async () => {
  let calls = 0;
  const scheduler = createCoalescedRefreshScheduler(async () => { calls += 1; }, 10);

  scheduler.schedule();
  scheduler.dispose();
  await wait(20);

  assert.equal(calls, 0);
});
