import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageService } from './account-usage-service.mjs';

for (const mode of ['api', 'legacy', 'unsupported', 'missing', 'failed', 'local-failed']) test(`service/${mode}/remote-local-isolation`, async () => {
  const provider = { id: 'one', channelId: mode === 'unsupported' ? 'openai-compatible' : mode === 'legacy' ? 'openai' : 'deepseek', authMethod: mode === 'legacy' ? 'oauth_chatgpt' : 'api_key' };
  let credentials = 0;
  let legacy = 0;
  const service = createAccountUsageService({
    adapters: { supports: (id) => id === 'deepseek', fetch: async (p, opts) => { assert.equal(opts.apiKey, 'private'); assert.equal(opts.force, true); return { success: true, balances: [{ currency: 'CNY', total: '1' }] }; } },
    resolveCredential: async () => { credentials++; if (mode === 'missing' || mode === 'failed') throw Object.assign(new Error('private'), { code: mode === 'missing' ? 'api_key_not_found' : 'other' }); return { apiKey: 'private' }; },
    supportsLegacyQuota: (auth) => auth === 'oauth_chatgpt',
    fetchLegacyQuota: async () => { legacy++; return { success: true, windows: [{ id: 'session', usedPercent: 25 }] }; },
    readLocalRows: async () => { if (mode === 'local-failed') throw new Error('private'); return [{ modelProviderId: 'one', inputTokens: 10 }]; },
  });
  const result = await service({ providerId: 'one', llmConfigStore: { listProviders: () => [provider] }, force: true });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(credentials, ['legacy', 'unsupported'].includes(mode) ? 0 : 1);
  assert.equal(legacy, mode === 'legacy' ? 1 : 0);
  if (mode === 'local-failed') { assert.equal(result.success, true); assert.equal(result.partial, true); }
  else assert.equal(result.localUsage.inputTokens, 10);
  if (mode === 'missing') assert.equal(result.status, 'missing_credential');
  if (mode === 'unsupported') assert.equal(result.status, 'unsupported');
  if (mode === 'failed') assert.equal(result.status, 'fetch_failed');
});
test('service/unknown-provider/no-side-effects', async () => {
  const service = createAccountUsageService({});
  assert.deepEqual(await service({ providerId: 'absent', llmConfigStore: { listProviders: () => [] } }), { success: false, status: 'provider_not_found' });
});
