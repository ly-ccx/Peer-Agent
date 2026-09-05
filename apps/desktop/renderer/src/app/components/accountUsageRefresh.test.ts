import test from 'node:test';
import assert from 'node:assert/strict';
import { accountUsageRefreshFailed } from './accountUsageRefresh.ts';
import { accountUsageLines } from './accountUsageView.ts';

for (const prior of [undefined, { success: true, accountUsageRevision: 'old', fetchedAt: '2026-09-05T00:00:00Z' }]) {
  test(`refresh-failure/current-revision/discards-old-${Boolean(prior)}`, () => {
    const result = accountUsageRefreshFailed(prior, 'current');
    assert.equal(result.accountUsageRevision, 'current');
    assert.equal(result.fetchedAt, undefined);
    assert.equal(result.stale, false);
    assert.equal(result.status, 'fetch_failed');
  });
}

test('refresh-failure/previous-observation/stale-with-original-time', () => {
  const previous = { success: true, fetchedAt: '2026-09-05T00:00:00Z', windows: [{ id: 'plan', usedPercent: 20 }] };
  const result = accountUsageRefreshFailed(previous);
  assert.equal(result.success, false);
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, previous.fetchedAt);
  assert.equal(previous.success, true);
  const lines = accountUsageLines(result, false).join('\n');
  assert.match(lines, /Stale data/);
  assert.match(lines, /20.0% used/);
});
test('refresh-failure/no-observation/no-invented-timestamp', () => {
  const result = accountUsageRefreshFailed();
  assert.equal(result.fetchedAt, undefined);
  assert.equal(result.stale, false);
  assert.equal(result.status, 'fetch_failed');
});
