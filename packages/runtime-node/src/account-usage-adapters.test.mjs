import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageAdapters } from './account-usage-adapters.mjs';

const cases = [
  ['deepseek', 'https://api.deepseek.com/anthropic', 'https://api.deepseek.com/user/balance', { balance_infos: [{ currency: 'CNY', total_balance: '1.25' }] }],
  ['kimi-coding-plan', 'https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding/v1/usages', { usage: { limit: 100, used: 10 } }],
  ['opencode-go', 'https://opencode.ai/zen/go/v1', 'https://opencode.ai/zen/go/v1/usage', { usage: { rolling: { usagePercent: 30, resetInSec: 100 } } }],
];
for (const [channelId, baseUrl, endpoint, payload] of cases) {
  const provider = { id: 'one', channelId, baseUrl, authMethod: 'api_key' };
  test(`${channelId}/api_key/success/cache-hit/credential-rotation/endpoint-isolation`, async () => {
    let calls = 0;
    let time = 1000;
    const adapters = createAccountUsageAdapters({ now: () => time, fetchImpl: async (url) => {
      calls++;
      assert.equal(url, endpoint);
      return new Response(JSON.stringify(payload));
    } });
    const first = await adapters.fetch(provider, { apiKey: 'first' });
    assert.equal(first.success, true);
    assert.equal(first.providerId, provider.id);
    time = 2000;
    assert.deepEqual(await adapters.fetch(provider, { apiKey: 'first' }), first);
    assert.equal(calls, 1);
    await adapters.fetch(provider, { apiKey: 'rotated' });
    assert.equal(calls, 2);
    assert.equal((await adapters.fetch({ ...provider, baseUrl: 'https://proxy.example' }, { apiKey: 'first' })).status, 'endpoint_not_supported');
    assert.equal(calls, 2);
  });
  test(`${channelId}/api_key/missing-credential/wrong-auth/no-network`, async () => {
    const adapters = createAccountUsageAdapters({ fetchImpl: () => assert.fail('no request allowed') });
    assert.equal((await adapters.fetch(provider)).status, 'missing_credential');
    assert.equal((await adapters.fetch({ ...provider, authMethod: 'oauth_chatgpt' })).status, 'unsupported');
  });
  test(`${channelId}/api_key/failure/no-raw-secret`, async () => {
    const adapters = createAccountUsageAdapters({ fetchImpl: async () => new Response('secret key', { status: 403 }) });
    const result = await adapters.fetch(provider, { apiKey: 'secret key' });
    assert.equal(result.status, 'auth_required');
    assert.ok(!JSON.stringify(result).includes('secret key'));
  });
}
for (const channelId of ['openai-compatible', 'anthropic-compatible']) test(`${channelId}/official-url-does-not-select-adapter`, async () => {
  const adapters = createAccountUsageAdapters({ fetchImpl: () => assert.fail('no request allowed') });
  assert.equal((await adapters.fetch({ id: 'one', channelId, baseUrl: cases[0][1], authMethod: 'api_key' }, { apiKey: 'test' })).status, 'unsupported');
});
for (const channelId of ['opencode-go-openai', 'opencode-go-anthropic']) test(`${channelId}/legacy-alias`, async () => {
  const adapters = createAccountUsageAdapters({ fetchImpl: async () => new Response(JSON.stringify(cases[2][3])) });
  const result = await adapters.fetch({ id: 'one', channelId, baseUrl: cases[2][1], authMethod: 'api_key' }, { apiKey: 'test' });
  assert.equal(result.success, true);
  assert.equal(result.channelId, 'opencode-go');
});
