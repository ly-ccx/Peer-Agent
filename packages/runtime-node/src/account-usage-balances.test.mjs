import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoonshotBalance, parseOpenRouterCredits, parseOpenRouterKey, subtractAccountAmounts } from './account-usage-balances.mjs';
import { createAccountUsageAdapters } from './account-usage-adapters.mjs';

const moonshot = { code: 0, status: true, data: { available_balance: '49.58000001', cash_balance: '-0.42', voucher_balance: '50.00' } };
const credits = { data: { total_credits: '100.3', total_usage: '0.2' } };
const key = { data: { limit: 20, limit_remaining: 15, limit_reset: 'weekly', usage: 8, usage_daily: 1, usage_weekly: 5, usage_monthly: 7 } };
test('moonshot/decimal-negative-cash-no-inferred-currency-or-window', () => {
  const result = parseMoonshotBalance(moonshot);
  assert.equal(result.balances[0].paid, '-0.42');
  assert.equal(result.balances[0].total, '49.58000001');
  assert.equal(result.balances[0].currency, '未标明币种');
  assert.deepEqual(result.unavailable.map((row) => row.dimension), ['windows', 'spend']);
  assert.equal(parseMoonshotBalance({ ...moonshot, data: { available_balance: 0 } }).balances[0].total, '0');
});
for (const payload of [{}, { ...moonshot, status: false }, { ...moonshot, code: 1 }, { ...moonshot, data: {} }, { ...moonshot, data: { available_balance: null } }]) {
  test(`moonshot/malformed-${JSON.stringify(payload)}`, () => assert.equal(parseMoonshotBalance(payload).success, false));
}
test('openrouter/exact-balance-and-account-total-not-key-total', () => {
  const result = parseOpenRouterCredits(credits);
  assert.equal(result.balances[0].total, '100.1');
  assert.equal(result.spend[0].scope, 'account');
  assert.equal(subtractAccountAmounts('0.1', '0.3'), '-0.2');
  assert.equal(subtractAccountAmounts('1.0', '1.00'), '0');
  assert.equal(parseOpenRouterCredits({ data: { total_credits: null, total_usage: 0 } }).success, false);
});
test('openrouter/key-window-and-spend-periods', () => {
  const result = parseOpenRouterKey(key);
  assert.equal(result.windows[0].used, 5);
  assert.equal(result.windows[0].remaining, 15);
  assert.equal(result.windows[0].resetsAt, undefined);
  assert.deepEqual(result.spend.map((item) => [item.period, item.amount, item.scope]), [['total', '8', 'api_key'], ['today', '1', 'api_key'], ['week', '5', 'api_key'], ['month', '7', 'api_key']]);
});
test('openrouter/unlimited-and-missing-are-not-zero', () => {
  const unlimited = parseOpenRouterKey({ data: { limit: null, usage: 0 } });
  assert.equal(unlimited.success, true);
  assert.equal(unlimited.windows.length, 0);
  assert.equal(unlimited.spend.length, 1);
  assert.match(unlimited.unavailable[0].reason, /未设置/);
  assert.equal(parseOpenRouterKey({ data: {} }).success, false);
});

// Region × success/auth failure × credential/endpoint isolation; no implicit regional retry.
for (const origin of ['https://api.moonshot.cn', 'https://api.moonshot.ai']) {
  for (const status of [200, 401]) test(`moonshot/${origin}/${status}/region-isolation`, async () => {
    const urls = [];
    const adapters = createAccountUsageAdapters({ fetchImpl: async (url) => { urls.push(url); return new Response(JSON.stringify(moonshot), { status }); } });
    const result = await adapters.fetch({ id: 'x', channelId: 'moonshot', authMethod: 'api_key', baseUrl: origin + '/v1' }, { apiKey: 'secret' });
    assert.equal(result.success, status === 200);
    assert.deepEqual(urls, [origin + '/v1/users/me/balance']);
  });
}
for (const channelId of ['moonshot', 'openrouter']) {
  for (const baseUrl of ['https://evil.test/v1', 'http://api.moonshot.cn/v1', 'https://user:pass@openrouter.ai/api/v1']) test(`${channelId}/endpoint-isolation/${baseUrl}`, async () => {
    const adapters = createAccountUsageAdapters({ fetchImpl: () => assert.fail('no request') });
    assert.equal((await adapters.fetch({ id: 'x', channelId, authMethod: 'api_key', baseUrl }, { apiKey: 'secret' })).status, 'endpoint_not_supported');
  });
}
for (const creditsOK of [true, false]) for (const keyOK of [true, false]) test(`openrouter/credits-${creditsOK}/key-${keyOK}`, async () => {
  const urls = [];
  const adapters = createAccountUsageAdapters({ now: () => 0, fetchImpl: async (url) => {
    urls.push(url);
    const isCredits = url.endsWith('/credits');
    return new Response(JSON.stringify(isCredits ? credits : key), { status: (isCredits ? creditsOK : keyOK) ? 200 : 403 });
  } });
  const result = await adapters.fetch({ id: 'x', channelId: 'openrouter', authMethod: 'api_key', baseUrl: 'https://openrouter.ai/api/v1' }, { apiKey: 'secret' });
  assert.equal(result.success, creditsOK || keyOK);
  assert.equal(result.balances?.length ?? 0, Number(creditsOK));
  assert.equal(result.windows?.length ?? 0, Number(keyOK));
  assert.deepEqual(urls.sort(), ['https://openrouter.ai/api/v1/credits', 'https://openrouter.ai/api/v1/key']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  if (creditsOK || keyOK) assert.equal(result.partial, !(creditsOK && keyOK));
});
