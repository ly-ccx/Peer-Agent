import { describe, expect, test } from 'bun:test';

import {
  modelApiKeyCredentialKey,
  modelOauthCredentialKey,
} from '@peer-agent/credential-helper';
import { ensureFreshGrokTokens } from '@peer-agent/runtime-node';

import {
  createTuiSharedModelCredentialStore,
  type TuiCredentialClient,
} from './model-credential-store.ts';

function createMemoryClient(initial: Readonly<Record<string, string>> = {}): {
  readonly client: TuiCredentialClient;
  readonly secrets: Map<string, string>;
  readonly calls: string[];
} {
  const secrets = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    secrets,
    calls,
    client: {
      getSecret(key) {
        calls.push(`get:${key}`);
        return secrets.get(key) ?? null;
      },
      setSecret(key, value) {
        calls.push(`set:${key}`);
        secrets.set(key, value);
      },
      deleteSecret(key) {
        calls.push(`delete:${key}`);
        return secrets.delete(key);
      },
    },
  };
}

describe('TUI shared model credential store', () => {
  test('is lazy and maps API keys to the shared provider group key', () => {
    const apiKeyKey = modelApiKeyCredentialKey('group-a');
    const memory = createMemoryClient({ [apiKeyKey]: 'shared-api-key' });
    const store = createTuiSharedModelCredentialStore({
      dataHome: '/tmp/peer-test',
      client: memory.client,
    });

    expect(memory.calls).toEqual([]);
    expect(store.getApiKey('group-a')).toBe('shared-api-key');
    expect(memory.calls).toEqual([`get:${apiKeyKey}`]);
  });

  test('parses OAuth tokens and never returns an unvalidated object', () => {
    const oauthKey = modelOauthCredentialKey('group-oauth');
    const memory = createMemoryClient({
      [oauthKey]: JSON.stringify({
        access: 'access-secret',
        refresh: 'refresh-secret',
        expires: 123,
        accountId: 'acct-1',
        ignored: 'not-exposed',
      }),
    });
    const store = createTuiSharedModelCredentialStore({
      dataHome: '/tmp/peer-test',
      client: memory.client,
    });

    expect(store.getOAuthTokens('group-oauth')).toEqual({
      access: 'access-secret',
      refresh: 'refresh-secret',
      expires: 123,
      accountId: 'acct-1',
    });
    memory.secrets.set(oauthKey, '{broken');
    expect(() => store.getOAuthTokens('group-oauth')).toThrow(
      'credential_oauth_tokens_invalid',
    );
  });

  test('keeps Grok scope metadata so refresh does not demand a fake re-login', async () => {
    const oauthKey = modelOauthCredentialKey('group-grok');
    const stored = {
      access: 'grok-access',
      refresh: 'grok-refresh',
      expires: Date.now() + 300_000,
      scope: 'openid profile email offline_access grok-cli:access api:access',
      issuer: 'https://auth.x.ai',
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    };
    const memory = createMemoryClient({
      [oauthKey]: JSON.stringify({
        ...stored,
        ignored: 'not-exposed',
      }),
    });
    const store = createTuiSharedModelCredentialStore({
      dataHome: '/tmp/peer-test',
      client: memory.client,
    });

    const tokens = store.getOAuthTokens('group-grok');
    expect(tokens).toEqual(stored);
    await expect(ensureFreshGrokTokens(tokens, {
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    })).resolves.toMatchObject({ refreshed: false, tokens: stored });
  });

  test('writes, verifies, and deletes OAuth tokens through the Helper client', () => {
    const oauthKey = modelOauthCredentialKey('group-oauth');
    const memory = createMemoryClient();
    const store = createTuiSharedModelCredentialStore({
      dataHome: '/tmp/peer-test',
      client: memory.client,
    });
    const tokens = { access: 'next-access', refresh: 'next-refresh', expires: 456 };

    store.setOAuthTokens('group-oauth', tokens);
    expect(JSON.parse(memory.secrets.get(oauthKey) ?? '{}')).toEqual(tokens);
    expect(memory.calls).toEqual([
      `set:${oauthKey}`,
      `get:${oauthKey}`,
    ]);

    memory.calls.length = 0;
    store.setOAuthTokens('group-oauth', null);
    expect(memory.secrets.has(oauthKey)).toBe(false);
    expect(memory.calls).toEqual([
      `delete:${oauthKey}`,
      `get:${oauthKey}`,
    ]);
  });

  test('rejects a Helper write that cannot be read back', () => {
    const client: TuiCredentialClient = {
      getSecret() {
        return null;
      },
      setSecret() {},
      deleteSecret() {
        return false;
      },
    };
    const store = createTuiSharedModelCredentialStore({
      dataHome: '/tmp/peer-test',
      client,
    });

    expect(() => store.setOAuthTokens('group-oauth', { access: 'secret' })).toThrow(
      'credential_write_verify_failed',
    );
  });
});
