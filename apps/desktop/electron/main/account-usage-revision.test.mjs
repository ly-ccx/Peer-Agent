import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageRevisions } from './account-usage-revision.mjs';
import { createAccountUsageService } from './account-usage-service.mjs';

test('revision/stable-view-secret-invalidation-and-endpoint-change', () => {
  const revisions = createAccountUsageRevisions();
  const p = { id: 'a', groupId: 'g', channelId: 'deepseek', authMethod: 'api_key', baseUrl: 'https://api.deepseek.com' };
  const first = revisions.revision(p);
  assert.equal(revisions.revision({ ...p, model: 'other' }), first);
  revisions.invalidate('g');
  const second = revisions.revision(p);
  assert.notEqual(first, second);
  assert.notEqual(revisions.revision({ ...p, baseUrl: 'https://other.test' }), second);
});

for (const mode of ['api', 'legacy']) for (const stage of ['credential', 'remote', 'local']) for (const change of ['key', 'account', 'endpoint', 'delete']) {
  if (mode === 'legacy' && stage === 'credential') continue;
  test(`identity/${mode}/${stage}/${change}/drops-old-observation`, async () => {
    let providers = [{ id: 'a', channelId: mode === 'api' ? 'deepseek' : 'openai', authMethod: mode === 'api' ? 'api_key' : 'oauth_chatgpt', baseUrl: 'https://api.deepseek.com', accountUsageRevision: 'one' }];
    const mutate = () => { providers = change === 'delete' ? [] : [{ ...providers[0], ...(change === 'endpoint' ? { baseUrl: 'https://other.test' } : change === 'account' ? { oauthStatus: { accountId: 'two' } } : { accountUsageRevision: 'two' }) }]; };
    const remote = async () => { if (stage === 'remote') mutate(); return { success: true, balances: [{ total: 'old-account' }] }; };
    const service = createAccountUsageService({
      adapters: { supports: () => true, fetch: remote },
      resolveCredential: async () => { if (stage === 'credential') mutate(); return { apiKey: 'secret' }; },
      supportsLegacyQuota: () => mode === 'legacy', fetchLegacyQuota: remote,
      readLocalRows: async () => { if (stage === 'local') mutate(); return []; },
    });
    const result = await service({ providerId: 'a', llmConfigStore: { listProviders: () => providers } });
    assert.deepEqual(result, { success: false, status: 'account_changed', providerId: 'a' });
  });
}
