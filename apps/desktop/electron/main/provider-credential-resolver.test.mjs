import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';

describe('provider credential resolver', () => {
  it('resolves Qoder local auth providers without a stored API key', async () => {
    const credential = await resolveProviderCredential({
      provider: { id: 'qoder-1', authMethod: 'qoder_local_auth' },
      llmConfigStore: {
        getDecryptedApiKey: () => {
          throw new Error('Qoder local auth should not read stored api key');
        },
      },
      loadQoderToken: async () => 'qoder-token',
    });

    assert.deepEqual(credential, {
      authMethod: 'qoder_local_auth',
      apiKey: 'qoder-token',
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
  it('虚拟记录用 credentialId 回退取/写 OAuth token（复合 id 在存储里不存在）', async () => {
    const refreshedTokens = {
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: Date.now() + 3_600_000,
      accountId: 'acct-2',
    };
    const getCalls = [];
    const setCalls = [];

    const credential = await resolveProviderCredential({
      // 展开出的订阅虚拟记录：id 是复合 id，credentialId 指向原始记录 id。
      provider: { id: 'chatgpt-1::gpt-5.4', credentialId: 'chatgpt-1', authMethod: 'oauth_chatgpt', model: 'gpt-5.4' },
      llmConfigStore: {
        getCredential: (id) => {
          getCalls.push(id);
          return {
            tokens: { access: 'old', refresh: 'old-r', expires: Date.now() - 1, accountId: 'acct-1' },
          };
        },
        setOAuthTokens: (...args) => setCalls.push(args),
      },
      ensureFreshChatGptTokens: async () => ({ tokens: refreshedTokens, refreshed: true }),
    });

    assert.equal(credential.apiKey, 'fresh-access');
    // 取 token 与回写都必须用 credentialId（原始记录 id），而非复合 id。
    assert.deepEqual(getCalls, ['chatgpt-1']);
    assert.deepEqual(setCalls, [['chatgpt-1', refreshedTokens]]);
  });
});
