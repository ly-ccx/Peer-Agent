import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageAdapters } from './account-usage-adapters.mjs';

const glm = { success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 20 }] } };
const rows = [
  ['minimax-cn', 'https://api.minimaxi.com/anthropic', { model_remains: [{ current_interval_total_count: 100, current_interval_usage_count: 75 }] }],
  ['minimax-global', 'https://api.minimax.io/anthropic', { model_remains: [{ current_interval_total_count: 100, current_interval_usage_count: 75 }] }],
  ['aliyun-bailian', 'https://coding.dashscope.aliyuncs.com/v1', { data: { codingPlanQuotaInfo: { per5HourTotalQuota: 100, per5HourUsedQuota: 20 } } }, 1, 'POST'],
  ['moonshot', 'https://api.moonshot.cn/v1', { code: 0, status: true, data: { available_balance: '0' } }],
  ['moonshot', 'https://api.moonshot.ai/v1', { code: 0, status: true, data: { available_balance: '0' } }],
  ['openrouter', 'https://openrouter.ai/api/v1', { data: { total_credits: 10, total_usage: 2, limit: null, usage: 2 } }, 2],
  ['deepseek', 'https://api.deepseek.com/anthropic', { balance_infos: [{ currency: 'CNY', total_balance: '0' }] }],
  ['kimi-coding-plan', 'https://api.kimi.com/coding/v1', { usage: { limit: 100, used: 20 } }],
  ['opencode-go', 'https://opencode.ai/zen/go/v1', { usage: { rolling: { usagePercent: 20, resetInSec: 60 } } }],
  ['glm-coding-plan-cn', 'https://open.bigmodel.cn/api/anthropic', glm],
  ['glm-coding-plan-global', 'https://api.z.ai/api/anthropic', glm],
];
const states = [
  ['malformed', () => new Response('{}'), 'invalid_response'],
  ['http-failure', () => new Response('private', { status: 500 }), 'fetch_failed'],
  ['auth-failure', () => new Response('private', { status: 401 }), 'auth_required'],
  ['redirect-denied', () => new Response('', { status: 302 }), 'redirect_denied'],
  ['timeout', () => new Promise(() => {}), 'timeout'],
];
for (const [channelId, baseUrl, payload, requests = 1, method = 'GET'] of rows) {
  const provider = { id: 'a', channelId, baseUrl, authMethod: 'api_key' };
  for (const scenario of ['missing-key', 'custom-endpoint', 'compatible-channel']) test(`adapter-matrix/${channelId}/${new URL(baseUrl).host}/${scenario}/no-network`, async () => {
    const adapters = createAccountUsageAdapters({ fetchImpl: () => assert.fail('credential must not be sent') });
    const target = scenario === 'custom-endpoint' ? { ...provider, baseUrl: 'https://untrusted.example/v1' }
      : scenario === 'compatible-channel' ? { ...provider, channelId: 'openai-compatible' } : provider;
    const result = await adapters.fetch(target, { apiKey: scenario === 'missing-key' ? '' : 'private' });
    assert.equal(result.status, scenario === 'missing-key' ? 'missing_credential' : scenario === 'custom-endpoint' ? 'endpoint_not_supported' : 'unsupported');
  });
  test(`adapter-matrix/${channelId}/${new URL(baseUrl).host}/key-change/cache-isolation`, async () => {
    let calls = 0;
    const adapters = createAccountUsageAdapters({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload)); } });
    await adapters.fetch(provider, { apiKey: 'first' });
    await adapters.fetch(provider, { apiKey: 'second' });
    assert.equal(calls, requests * 2);
    await adapters.fetch(provider, { apiKey: 'second' });
    assert.equal(calls, requests * 2);
  });
  for (const [state, respond, expected] of states) test(`adapter-matrix/${channelId}/api_key/${state}`, async () => {
    const adapters = createAccountUsageAdapters({ timeoutMs: 10, fetchImpl: async (_, opts) => {
      assert.equal(opts.method, method);
      assert.equal(opts.redirect, 'error');
      return respond();
    } });
    const result = await adapters.fetch(provider, { apiKey: 'private' });
    assert.equal(result.success, false);
    assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes('private'));
  });
  test(`adapter-matrix/${channelId}/api_key/success-expiry-force-instance-isolation`, async () => {
    let now = 0;
    let calls = 0;
    const adapters = createAccountUsageAdapters({ now: () => now, ttlMs: 100, fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload)); } });
    const options = { apiKey: 'private' };
    const first = await adapters.fetch(provider, options);
    assert.equal(first.success, true);
    now = 50;
    assert.deepEqual(await adapters.fetch(provider, options), first);
    assert.equal(calls, requests);
    now = 101;
    assert.equal((await adapters.fetch(provider, options)).success, true);
    assert.equal(calls, 2 * requests);
    await adapters.fetch(provider, { ...options, force: true });
    assert.equal(calls, 3 * requests);
    await adapters.fetch({ ...provider, id: 'b' }, options);
    assert.equal(calls, 4 * requests);
    adapters.clear();
    await adapters.fetch(provider, options);
    assert.equal(calls, 5 * requests);
  });
}
