import assert from 'node:assert/strict';
import test from 'node:test';
import { median, metric, PERF_BUDGETS, measureOperation } from './perf-project-agent.mjs';

test('synchronous timing ends when the API returns, before unrelated queued microtasks', async () => {
  let ticks = 0;
  const result = await measureOperation(() => {
    ticks = 5; queueMicrotask(() => { ticks = 100; }); return 'returned';
  }, () => ticks);
  assert.equal(result.value, 'returned'); assert.equal(result.elapsed, 5);
  assert.equal(ticks, 100, 'the observer resumes after the queued work, but the synchronous API already returned');
});

test('asynchronous timing includes actual promise settlement', async () => {
  let ticks = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const measured = measureOperation(() => pending, () => ticks);
  ticks = 12; resolve('settled');
  assert.deepEqual(await measured, { value: 'settled', elapsed: 12 });
});

test('performance gates require five actual finite samples and preserve input order', () => {
  const samples = [8, 1, 5, 3, 10];
  assert.equal(median(samples), 5);
  assert.deepEqual(samples, [8, 1, 5, 3, 10]);
  for (const invalid of [[], [1, 2], [1, 2, 3, 4, NaN], [1, 2, 3, 4, -1], [1, 2, 3, 4, Infinity]]) {
    assert.throws(() => median(invalid));
  }
});

test('performance budget equality fails; a measured local result does not imply a live model result', () => {
  assert.equal(metric('search', [150, 150, 150, 150, 150]).pass, false);
  assert.equal(metric('search', [149, 150, 149, 149, 150]).pass, true);
  assert.equal(PERF_BUDGETS.realModel, 6000);
  assert.equal(metric('realModel', [6000, 6000, 6000, 6000, 6000]).pass, false);
});
