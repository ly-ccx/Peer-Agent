import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAccountLocalUsage, attachAccountLocalUsage } from './account-usage-local.mjs';
const provider = { id: 'a', groupId: 'group-a' };
const providers = [provider, { id: 'b', groupId: 'group-a' }, { id: 'c', groupId: 'group-c' }];
const rows = [
  { modelProviderId: 'a', providerRequestCount: 3, inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.1, at: '2026-09-05T00:00:00Z' },
  { modelProviderId: 'b', inputTokens: 5, estimatedCostUsd: 0.2, at: '2026-09-04T00:00:00Z' },
  { modelProviderId: 'group-a::model', cacheReadTokens: 8, estimatedCostUsd: 0, at: '2026-09-06T00:00:00Z' },
  { groupId: 'group-c', modelProviderId: 'a', inputTokens: 999 },
  { modelProviderId: 'c', inputTokens: 999 },
];
for (const status of ['ok', 'fetch_failed', 'missing_credential', 'unsupported']) test(`local/remote-${status}/group-attribution/retained-range`, () => {
  const snapshot = { success: status === 'ok', status };
  const result = attachAccountLocalUsage(snapshot, provider, providers, rows);
  assert.equal(result.status, status);
  assert.equal(result.success, snapshot.success);
  assert.equal(result.localUsage.requests, 5);
  assert.equal(result.localUsage.inputTokens, 25);
  assert.equal(result.localUsage.cacheReadTokens, 8);
  assert.ok(Math.abs(result.localUsage.estimatedCostUsd - 0.3) < 1e-10);
  assert.equal(result.localUsage.from, '2026-09-04T00:00:00.000Z');
  assert.equal(result.localUsage.to, '2026-09-06T00:00:00.000Z');
  assert.equal(result.localUsage.scope, 'local_only');
  assert.match(result.localUsage.note, /换账号/);
  assert.equal(snapshot.localUsage, undefined);
});
test('local/empty/not-account-zero/no-fabricated-cost', () => {
  const result = aggregateAccountLocalUsage(provider, providers, []);
  assert.equal(result.requests, 0);
  assert.equal(result.estimatedCostUsd, undefined);
  assert.equal(result.from, undefined);
  assert.match(result.note, /不代表账户没有消费/);
});
test('local/partial-pricing/invalid-records/no-partial-total', () => {
  const result = aggregateAccountLocalUsage(provider, providers, [...rows, null, { groupId: 'group-a', inputTokens: -1, outputTokens: Infinity, estimatedCostUsd: null, at: 'invalid' }]);
  assert.equal(result.inputTokens, 25);
  assert.equal(result.outputTokens, 10);
  assert.equal(result.estimatedCostUsd, undefined);
  assert.match(result.note, /部分记录缺少价格/);
});
test('local/ungrouped-provider/no-prefix-collision', () => {
  const result = aggregateAccountLocalUsage({ id: 'one' }, [], [{ modelProviderId: 'one', inputTokens: 1 }, { modelProviderId: 'one-more', inputTokens: 100 }]);
  assert.equal(result.inputTokens, 1);
});
