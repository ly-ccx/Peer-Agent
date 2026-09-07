import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { accountUsageViewIdentity, currentAccountUsage } from './accountUsageIdentity.ts';
const provider = { id: 'one', channelId: 'deepseek', baseUrl: 'https://api.deepseek.com', authMethod: 'api_key', accountUsageRevision: 'one' } as LlmProviderConfigView;
for (const [axis, change] of Object.entries({ key: { accountUsageRevision: 'two' }, endpoint: { baseUrl: 'https://other.test' }, auth: { authMethod: 'oauth_chatgpt' }, channel: { channelId: 'moonshot' }, account: { oauthStatus: { status: 'connected', accountId: 'two' } } })) {
  test(`view/identity/${axis}/invalidates-request-identity`, () => {
    assert.notEqual(accountUsageViewIdentity(provider), accountUsageViewIdentity({ ...provider, ...change } as LlmProviderConfigView));
  });
}
test('view/identity/revision-mismatch-and-account-change-hide-old-snapshot', () => {
  const quota = { success: true, accountUsageRevision: 'one' };
  assert.equal(currentAccountUsage(quota, provider), quota);
  assert.equal(currentAccountUsage(quota, { ...provider, accountUsageRevision: 'two' }), undefined);
  assert.equal(currentAccountUsage({ success: false, status: 'account_changed' }, provider), undefined);
  assert.notEqual(accountUsageViewIdentity(undefined), accountUsageViewIdentity(provider));
});
