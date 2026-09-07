import test from 'node:test';
import assert from 'node:assert/strict';
import { accountUsageLines } from './accountUsageView.ts';

test('view/balance/precision/zero/paid-granted', () => {
  const text = accountUsageLines({ success: true, balances: [{ currency: 'CNY', total: '0.000000001', paid: '0', granted: '0.000000001', source: 'api_key', scope: 'account' }] }, true).join('\n');
  assert.match(text, /0\.000000001/);
  assert.match(text, /充值: CNY 0/);
  assert.match(text, /account \/ api_key/);
});
test('view/multiple-windows/missing-percent/not-zero', () => {
  const text = accountUsageLines({ success: true, windows: [{ id: 'plan', used: 5, limit: 10 }, { id: 'weekly', usedPercent: 0, resetsAt: '2026-09-06' }] }, false).join('\n');
  assert.match(text, /plan: 5 \/ 10/);
  assert.match(text, /weekly: 0.0% used/);
  assert.match(text, /resets 2026-09-06/);
});
for (const success of [true, false]) test(`view/local/remote-${success}/stale`, () => {
  const text = accountUsageLines({ success, stale: true, status: 'timeout', localUsage: { source: 'local', scope: 'local_only', requests: 0, inputTokens: 0, outputTokens: 0, note: 'Not account billing' } }, false).join('\n');
  assert.match(text, /Stale data/);
  assert.match(text, /local usage/);
  assert.doesNotMatch(text, /Estimated cost/);
  if (!success) assert.match(text, /timed out/);
});
test('view/unavailable-and-empty', () => {
  assert.deepEqual(accountUsageLines(undefined, true), []);
  assert.match(accountUsageLines({ success: false, unavailable: [{ dimension: 'balance', reason: 'Needs session', requiredAuth: 'web_session' }] }, false).join('\n'), /Needs session \(web_session\)/);
});
