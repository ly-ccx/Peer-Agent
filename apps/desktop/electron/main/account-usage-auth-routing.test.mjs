import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageService } from './account-usage-service.mjs';

const pairs = [['oauth_chatgpt', 'openai'], ['oauth_google', 'google-ai'], ['oauth_grok', 'grok'], ['qoder_local_auth', 'qoder'], ['local_cli', 'qoder']];
for (const [authMethod, expected] of pairs) {
  for (const channelId of [expected, undefined, 'openai-compatible', 'deepseek']) {
    test(`auth-routing/${authMethod}/${channelId ?? 'legacy-no-channel'}`, async () => {
      let called = 0;
      const service = createAccountUsageService({
        adapters: { supports: () => false },
        resolveCredential: () => assert.fail('must not read API key'),
        supportsLegacyQuota: () => true,
        fetchLegacyQuota: async () => { called++; return { success: true }; },
        readLocalRows: async () => [],
      });
      const result = await service({ providerId: 'one', llmConfigStore: { listProviders: () => [{ id: 'one', authMethod, channelId }] } });
      const allowed = !channelId || channelId === expected;
      assert.equal(called, allowed ? 1 : 0);
      assert.equal(result.success, allowed);
      assert.equal(result.localUsage.scope, 'local_only');
    });
  }
}
