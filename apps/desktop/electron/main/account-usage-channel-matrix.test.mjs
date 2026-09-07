import test from 'node:test';
import assert from 'node:assert/strict';
import { listChannelDescriptors } from './provider-channels.mjs';
import { createAccountUsageService } from './account-usage-service.mjs';
import { createAccountUsageAdapters } from '../../../../packages/runtime-node/src/account-usage-adapters.mjs';
import { supportsSubscriptionQuota } from '../../../../packages/runtime-node/src/subscription-quota.mjs';

// Covers routing and missing credentials for every registered authentication variant.
// Does not replace each vendor's successful-response and failure-state matrix.
for (const channel of listChannelDescriptors()) {
  for (const authMethod of Object.keys(channel.authMethods)) {
    for (const hasRows of [false, true]) test(`channels/${channel.id}/${authMethod}/missing-credential/local-${hasRows}`, async () => {
      const provider = { id: 'fixture', channelId: channel.id, authMethod, baseUrl: channel.defaults.baseUrl };
      let credentials = 0;
      let legacy = 0;
      const adapters = createAccountUsageAdapters({ fetchImpl: () => assert.fail('no network without a credential') });
      const service = createAccountUsageService({
        adapters,
        resolveCredential: async () => { credentials++; return {}; },
        fetchLegacyQuota: async () => { legacy++; return { success: false, status: 'missing_credential' }; },
        supportsLegacyQuota: supportsSubscriptionQuota,
        readLocalRows: async () => hasRows ? [{ modelProviderId: 'fixture', inputTokens: 7 }] : [],
      });
      const result = await service({ providerId: 'fixture', llmConfigStore: { listProviders: () => [provider] } });
      assert.equal(result.success, false);
      assert.equal(result.localUsage.inputTokens, hasRows ? 7 : 0);
      assert.equal(result.localUsage.scope, 'local_only');
      if (supportsSubscriptionQuota(authMethod)) {
        assert.equal(legacy, 1);
        assert.equal(credentials, 0);
      } else if (adapters.supports(channel.id)) {
        assert.equal(credentials, 1);
        assert.equal(result.status, 'missing_credential');
      } else {
        assert.equal(credentials, 0);
        assert.equal(result.status, 'unsupported');
        assert.deepEqual(result.unavailable.map((row) => row.dimension), ['balance', 'windows', 'spend']);
        assert.ok(result.unavailable.every((row) => row.reason.length > 0));
      }
    });
  }
}
