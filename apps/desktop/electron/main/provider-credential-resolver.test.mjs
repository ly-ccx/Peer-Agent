import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';

describe('provider credential resolver', () => {
  it('resolves local CLI providers without a stored API key', async () => {
    const credential = await resolveProviderCredential({
      provider: { id: 'qoder-1', authMethod: 'local_cli' },
      llmConfigStore: {
        getDecryptedApiKey: () => {
          throw new Error('local CLI should not read api key');
        },
      },
    });

    assert.deepEqual(credential, {
      authMethod: 'local_cli',
      apiKey: '',
      accountId: null,
    });
  });

  it('resolves ChatGPT subscription OAuth tokens and refreshes through the shared credential seam', async () => {
    const refreshedTokens = {
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: Date.now() + 3_600_000,
      accountId: 'acct-2',
    };
    const setCalls = [];

    const credential = await resolveProviderCredential({
      provider: { id: 'p1', authMethod: 'oauth_chatgpt' },
      llmConfigStore: {
        getCredential: () => ({
          tokens: {
            access: 'old-access',
            refresh: 'old-refresh',
            expires: Date.now() - 1,
            accountId: 'acct-1',
          },
        }),
        setOAuthTokens: (...args) => setCalls.push(args),
      },
      ensureFreshChatGptTokens: async () => ({ tokens: refreshedTokens, refreshed: true }),
    });

    assert.deepEqual(credential, {
      authMethod: 'oauth_chatgpt',
      apiKey: 'fresh-access',
      accountId: 'acct-2',
    });
    assert.deepEqual(setCalls, [['p1', refreshedTokens]]);
  });

  it('maps missing OAuth login to a stable credential error code', async () => {
    await assert.rejects(
      () => resolveProviderCredential({
        provider: { id: 'p1', authMethod: 'oauth_chatgpt' },
        llmConfigStore: { getCredential: () => ({ tokens: null }) },
        ensureFreshChatGptTokens: async () => {
          throw new Error('should not refresh without tokens');
        },
      }),
      (error) => {
        assert.equal(getProviderCredentialErrorCode(error), 'oauth_not_logged_in');
        return true;
      },
    );
  });
});
