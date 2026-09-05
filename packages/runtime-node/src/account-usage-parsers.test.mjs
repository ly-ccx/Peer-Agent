import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepSeekBalance, parseKimiUsage, parseOpenCodeUsage } from './account-usage-parsers.mjs';

test('deepseek/balance/multicurrency/decimal-precision/zero/negative', () => {
  const result = parseDeepSeekBalance({ balance_infos: [
    { currency: 'CNY', total_balance: '123456789.123456789', topped_up_balance: '123456789', granted_balance: '0.123456789' },
    { currency: 'USD', total_balance: '0' }, { currency: 'CNY', total_balance: '-0.01' },
  ] });
  assert.equal(result.balances[0].total, '123456789.123456789');
  assert.equal(result.balances[1].total, '0');
  assert.equal(result.balances[1].paid, undefined);
  assert.equal(result.balances[2].total, '-0.01');
  assert.equal(result.balances[0].scope, 'account');
  assert.equal(result.unavailable[0].requiredAuth, 'web_session');
});
test('deepseek/partial/invalid-currency-and-amount-not-zero', () => {
  const result = parseDeepSeekBalance({ balance_infos: [null, { currency: 'USD', total_balance: null }, { currency: 'secret', total_balance: '10' }, { currency: 'CNY', total_balance: '1.00' }] });
  assert.equal(result.balances.length, 1);
  assert.equal(result.partial, true);
});

test('kimi/windows/main-and-additional/numeric-and-string/reset-alias', () => {
  const result = parseKimiUsage({ usage: { limit: '100', remaining: '75', resetAt: '2026-09-06T00:00:00Z' }, limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 20, used: 10 } }] });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].label, '计划额度');
  assert.equal(result.windows[0].usedPercent, 25);
  assert.equal(result.windows[0].resetsAt, '2026-09-06T00:00:00.000Z');
  assert.equal(result.windows[1].label, '5 小时');
  assert.equal(result.windows[1].remaining, 10);
  assert.equal(result.windows[1].scope, 'subscription');
});
test('kimi/windows/zero-limit/no-fabricated-percent/missing-reset', () => {
  const result = parseKimiUsage({ usage: { limit: 0, used: 0 } });
  assert.equal(result.windows[0].usedPercent, undefined);
  assert.equal(result.windows[0].resetsAt, undefined);
});

test('opencode/windows/three-windows/absolute-and-relative-reset', () => {
  const result = parseOpenCodeUsage({ usage: { rolling: { usagePercent: 0, resetInSec: 3600 }, weekly: { usedPercent: 50, resetAt: '2026-09-07T00:00:00Z' }, monthly: { usagePercent: 110 } } }, Date.parse('2026-09-05T00:00:00Z'));
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[0].resetsAt, '2026-09-05T01:00:00.000Z');
  assert.equal(result.windows[1].usedPercent, 50);
  assert.equal(result.windows[2].remainingPercent, 0);
  assert.equal(result.windows[2].resetsAt, undefined);
});
test('opencode/windows/absent-week-month-not-zero', () => {
  const result = parseOpenCodeUsage({ usage: { rolling: { usagePercent: 30 } } });
  assert.equal(result.windows.length, 1);
  assert.equal(result.balances, undefined);
});
for (const [name, parse] of [['deepseek', parseDeepSeekBalance], ['kimi', parseKimiUsage], ['opencode', parseOpenCodeUsage]]) {
  test(`${name}/malformed-or-empty/not-success/not-zero`, () => {
    for (const data of [{}, { usage: { limit: null, used: null, rolling: { usagePercent: null } } }]) {
      const result = parse(data);
      assert.equal(result.success, false);
      assert.equal(result.status, 'invalid_response');
    }
  });
}
