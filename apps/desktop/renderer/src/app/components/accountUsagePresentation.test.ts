import test from 'node:test';
import assert from 'node:assert/strict';
import { usageMoney, usageNumber, usageTime, usageWindow, usageWindows, usageLegacyMetrics, usageScope, usageSource, usageAuth, usageDimension, usageFailure } from './accountUsagePresentation.ts';

for (const zh of [true, false]) {
  const lang = zh ? 'zh' : 'en';
  test(`presentation/${lang}/money/vendor-exact-local-rounded`, () => {
    assert.equal(usageMoney('1234.123456789012345', 'CNY', zh), 'CNY 1,234.123456789012345');
    assert.equal(usageMoney('-0.42', 'CNY', zh), 'CNY -0.42');
    assert.equal(usageMoney('0', 'USD', zh), 'USD 0.00');
    assert.equal(usageMoney(24.208992943999995, 'USD', zh), 'USD 24.21');
    assert.equal(usageMoney(0.00001, 'USD', zh), 'USD <0.01');
  });
  test(`presentation/${lang}/numbers-time/internal-enums`, () => {
    assert.equal(usageNumber(1374, zh), '1,374');
    assert.equal(usageNumber(undefined, zh), '—');
    assert.ok(usageNumber(28134424, zh, true).length < 12);
    assert.ok(!usageTime('2026-09-05T09:14:12.146Z', zh).includes('T09:14:12.146Z'));
    assert.equal(usageTime('invalid', zh), '—');
    assert.notEqual(usageScope('api_key', zh), 'api_key');
    assert.notEqual(usageSource('api_key', zh), 'api_key');
    assert.notEqual(usageDimension('balance', zh), 'balance');
    assert.notEqual(usageAuth('web_session', zh), 'web_session');
    assert.ok(usageFailure('fetch_failed', zh));
  });
  for (const [name, input, expected] of [
    ['zero', { usedPercent: 0 }, 0], ['remaining', { remainingPercent: 5 }, 95],
    ['counts', { used: 25, limit: 50 }, 50], ['missing', {}, undefined],
    ['zero-limit', { used: 0, limit: 0 }, undefined], ['over-limit', { usedPercent: 120 }, 100],
  ] as const) test(`presentation/${lang}/window/${name}`, () => {
    const result = usageWindow({ id: 'w', ...input }, zh);
    assert.equal(result.percent, expected);
    if (name === 'over-limit') assert.equal(result.text, '120%');
    assert.equal(result.tone, expected !== undefined && expected >= 90 ? 'high' : 'normal');
  });
}
test('presentation/legacy/oauth-cli-no-duplicate-window-no-lost-credits', () => {
  assert.equal(usageWindows({ success: true, usedPercent: 20 }).length, 1);
  assert.equal(usageWindows({ success: true, usedPercent: 20, windows: [{ id: 'w' }] }).length, 1);
  assert.equal(usageWindows({ success: false }).length, 0);
  assert.deepEqual(usageLegacyMetrics({ success: true, availableCredits: 0, planCreditsUsed: 2, planCreditsTotal: 30, orgPackageUsed: 10, orgPackageCap: 50 }, true).map((item) => item.value), ['0', '2 / 30', '10 / 50']);
});
