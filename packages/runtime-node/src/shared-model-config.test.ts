import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getSharedModelConfigPath,
  loadSharedModelMetadata,
  loadSharedModelMetadataList,
  loadSharedModelSelection,
  selectDesktopDefaultProvider,
  type ChatGptOAuthTokens,
  type SharedModelCredentialStore,
} from './shared-model-config.ts';

function createCredentialStore(initial?: {
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly oauthTokens?: Readonly<Record<string, ChatGptOAuthTokens>>;
}): {
  readonly store: SharedModelCredentialStore;
  readonly apiKeys: Map<string, string>;
  readonly oauthTokens: Map<string, ChatGptOAuthTokens>;
  readonly reads: { apiKey: number; oauth: number };
} {
  const apiKeys = new Map(Object.entries(initial?.apiKeys ?? {}));
  const oauthTokens = new Map(Object.entries(initial?.oauthTokens ?? {}));
  const reads = { apiKey: 0, oauth: 0 };
  return {
    apiKeys,
    oauthTokens,
    reads,
    store: {
      getApiKey(credentialId) {
        reads.apiKey += 1;
        return apiKeys.get(credentialId) ?? null;
      },
      getOAuthTokens(credentialId) {
        reads.oauth += 1;
        return oauthTokens.get(credentialId) ?? null;
      },
      setOAuthTokens(credentialId, tokens) {
        if (tokens) oauthTokens.set(credentialId, tokens);
        else oauthTokens.delete(credentialId);
      },
    },
  };
}

test('selectDesktopDefaultProvider follows the configured Desktop default', () => {
  const providers = [
    {
      id: 'api-1',
      groupId: 'group-api',
      model: 'gpt-api',
      enabled: true,
      isDefault: false,
      apiKeyConfigured: true,
    },
    {
      id: 'oauth-1',
      groupId: 'group-oauth',
      model: 'gpt-oauth',
      enabled: true,
      isDefault: true,
      authMethod: 'oauth_chatgpt' as const,
      oauthConfigured: true,
    },
  ];
  assert.equal(selectDesktopDefaultProvider(providers)?.id, 'oauth-1');
});

test('loadSharedModelMetadata reads only non-sensitive metadata', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-model-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'provider-1',
      groupId: 'credential-group',
      name: 'Desktop provider',
      provider: 'openai',
      model: 'gpt-shared',
      baseUrl: 'https://models.example/v1',
      enabled: true,
      isDefault: true,
      apiKeyConfigured: true,
    }]));
    const credentials = createCredentialStore({
      apiKeys: { 'credential-group': 'must-not-be-read' },
    });

    const metadata = loadSharedModelMetadata({
      userDataPath,
      credentialStore: credentials.store,
    });
    assert.equal(metadata?.model, 'gpt-shared');
    assert.equal(metadata?.credentialId, 'credential-group');
    assert.equal(metadata?.credentialStored, true);
    assert.deepEqual(credentials.reads, { apiKey: 0, oauth: 0 });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('loadSharedModelSelection resolves an API key by provider group', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-api-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'provider-1',
      groupId: 'credential-group',
      name: 'Desktop provider',
      provider: 'openai',
      model: 'gpt-shared',
      enabled: true,
      isDefault: true,
      apiKeyConfigured: true,
    }]));
    const credentials = createCredentialStore({
      apiKeys: { 'credential-group': 'desktop-secret' },
    });

    const selection = loadSharedModelSelection({
      userDataPath,
      credentialStore: credentials.store,
    });
    assert.equal(selection?.credentialId, 'credential-group');
    assert.equal(selection?.apiKey, 'desktop-secret');
    assert.equal(credentials.reads.apiKey, 1);
    assert.equal(readFileSync(configFile, 'utf8').includes('desktop-secret'), false);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('loadSharedModelSelection persists OAuth tokens in the credential store and metadata only in JSON', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-oauth-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'oauth-1',
      groupId: 'oauth-group',
      name: 'ChatGPT subscription',
      provider: 'openai',
      authMethod: 'oauth_chatgpt',
      model: 'gpt-5.5',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      enabled: true,
      isDefault: true,
      oauthConfigured: true,
    }]));
    const oldTokens = { access: 'old-access', refresh: 'refresh', expires: 123 };
    const nextTokens = {
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 456,
      accountId: 'acct-1',
    };
    const credentials = createCredentialStore({
      oauthTokens: { 'oauth-group': oldTokens },
    });

    const selection = loadSharedModelSelection({
      userDataPath,
      credentialStore: credentials.store,
    });
    assert.equal(selection?.oauthTokens?.access, 'old-access');
    selection?.persistOAuthTokens(nextTokens);

    assert.deepEqual(credentials.oauthTokens.get('oauth-group'), nextTokens);
    const persistedText = readFileSync(configFile, 'utf8');
    const [persisted] = JSON.parse(persistedText) as Array<Record<string, unknown>>;
    assert.equal(persisted.oauthConfigured, true);
    assert.equal(persisted.oauthExpires, 456);
    assert.equal(persisted.oauthAccountId, 'acct-1');
    assert.equal(Object.hasOwn(persisted, 'oauthTokens'), false);
    assert.equal(persistedText.includes('new-access'), false);
    assert.equal(persistedText.includes('new-refresh'), false);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('OAuth metadata write failure restores the previous credential', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-rollback-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'oauth-1',
      groupId: 'oauth-group',
      provider: 'openai',
      authMethod: 'oauth_chatgpt',
      model: 'gpt-5.5',
      enabled: true,
      isDefault: true,
      oauthConfigured: true,
    }]));
    const oldTokens = { access: 'old-access', refresh: 'old-refresh' };
    const credentials = createCredentialStore({
      oauthTokens: { 'oauth-group': oldTokens },
    });
    const selection = loadSharedModelSelection({
      userDataPath,
      credentialStore: credentials.store,
      writeProviders() {
        throw new Error('metadata_write_failed');
      },
    });

    assert.throws(
      () => selection?.persistOAuthTokens({ access: 'new-access' }),
      /metadata_write_failed/,
    );
    assert.deepEqual(credentials.oauthTokens.get('oauth-group'), oldTokens);
    assert.equal(readFileSync(configFile, 'utf8').includes('new-access'), false);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('loadSharedModelSelection returns null without a credential store or for unsupported auth', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-unsupported-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'google-1',
      groupId: 'google-group',
      model: 'gemini',
      enabled: true,
      isDefault: true,
      authMethod: 'oauth_google',
      oauthConfigured: true,
    }]));
    assert.equal(loadSharedModelSelection({ userDataPath }), null);
    assert.equal(
      loadSharedModelSelection({
        userDataPath,
        credentialStore: createCredentialStore().store,
      }),
      null,
    );
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('legacy encrypted fields are not treated as usable TUI credentials', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-legacy-'));
  try {
    const configFile = getSharedModelConfigPath(userDataPath);
    writeFileSync(configFile, JSON.stringify([{
      id: 'legacy-1',
      model: 'legacy-model',
      enabled: true,
      isDefault: true,
      authMethod: 'api_key',
      apiKey: { encrypted: true, data: 'electron-ciphertext' },
    }]));

    const metadata = loadSharedModelMetadata({ userDataPath });
    assert.equal(metadata?.credentialStored, false);
    assert.equal(
      loadSharedModelSelection({
        userDataPath,
        credentialStore: createCredentialStore().store,
      }),
      null,
    );
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('loadSharedModelMetadataList expands Desktop v2 channels/models config', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-v2-'));
  try {
    writeFileSync(getSharedModelConfigPath(userDataPath), JSON.stringify({
      version: 2,
      channels: [
        {
          id: 'channel-api',
          groupId: 'channel-api',
          name: 'Idealab',
          provider: 'openai',
          baseUrl: 'https://example.test/v1',
          authMethod: 'api_key',
          apiKeyConfigured: true,
        },
        {
          id: 'channel-oauth',
          groupId: 'channel-oauth',
          name: 'ChatGPT',
          provider: 'openai',
          baseUrl: 'https://chatgpt.example/v1',
          authMethod: 'oauth_chatgpt',
          oauthConfigured: true,
        },
        {
          id: 'channel-grok',
          groupId: 'channel-grok',
          name: 'Grok',
          provider: 'xai',
          baseUrl: 'https://grok.example',
          authMethod: 'oauth_grok',
          oauthConfigured: true,
        },
      ],
      models: [
        {
          id: 'model-api-1',
          groupId: 'channel-api',
          model: 'gpt-test',
          enabled: true,
          isDefault: false,
        },
        {
          id: 'model-oauth-1',
          groupId: 'channel-oauth',
          model: 'gpt-5',
          enabled: true,
          isDefault: false,
        },
        {
          id: 'model-grok-1',
          groupId: 'channel-grok',
          model: 'grok-4.5',
          enabled: true,
          isDefault: true,
        },
        {
          id: 'model-missing-channel',
          groupId: 'missing',
          model: 'ignored',
          enabled: true,
        },
      ],
    }, null, 2));

    const list = loadSharedModelMetadataList({ userDataPath });
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((item) => ({
        credentialId: item.credentialId,
        model: item.model,
        authMethod: item.authMethod,
        displayName: item.displayName,
      })),
      [
        {
          credentialId: 'channel-api',
          model: 'gpt-test',
          authMethod: 'api_key',
          displayName: 'Idealab',
        },
        {
          credentialId: 'channel-oauth',
          model: 'gpt-5',
          authMethod: 'oauth_chatgpt',
          displayName: 'ChatGPT',
        },
        {
          credentialId: 'channel-grok',
          model: 'grok-4.5',
          authMethod: 'oauth_grok',
          displayName: 'Grok',
        },
      ],
    );

    const metadata = loadSharedModelMetadata({ userDataPath });
    assert.equal(metadata?.credentialId, 'channel-grok');
    assert.equal(metadata?.model, 'grok-4.5');
    assert.equal(metadata?.authMethod, 'oauth_grok');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('loadSharedModelSelection resolves API keys from Desktop v2 config', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-v2-'));
  const credentials = createCredentialStore({
    apiKeys: { 'channel-api': 'desktop-secret' },
  });
  try {
    writeFileSync(getSharedModelConfigPath(userDataPath), JSON.stringify({
      version: 2,
      channels: [{
        id: 'channel-api',
        groupId: 'channel-api',
        name: 'Idealab',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        authMethod: 'api_key',
        apiKeyConfigured: true,
      }],
      models: [{
        id: 'model-api-1',
        groupId: 'channel-api',
        model: 'gpt-test',
        enabled: true,
        isDefault: true,
      }],
    }, null, 2));

    const selection = loadSharedModelSelection({
      userDataPath,
      credentialStore: credentials.store,
    });
    assert.equal(selection?.credentialId, 'channel-api');
    assert.equal(selection?.apiKey, 'desktop-secret');
    assert.equal(selection?.model, 'gpt-test');
    assert.equal(selection?.baseUrl, 'https://example.test/v1');
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('persistOAuthTokens keeps Desktop v2 channels/models layout', () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-v2-'));
  const credentials = createCredentialStore({
    oauthTokens: {
      'channel-oauth': {
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 1_700_000_000_000,
      },
    },
  });
  try {
    writeFileSync(getSharedModelConfigPath(userDataPath), JSON.stringify({
      version: 2,
      channels: [{
        id: 'channel-oauth',
        groupId: 'channel-oauth',
        name: 'ChatGPT',
        provider: 'openai',
        baseUrl: 'https://chatgpt.example/v1',
        authMethod: 'oauth_chatgpt',
        oauthConfigured: true,
        oauthExpires: 1_700_000_000_000,
      }],
      models: [{
        id: 'model-oauth-1',
        groupId: 'channel-oauth',
        model: 'gpt-5',
        enabled: true,
        isDefault: true,
      }],
    }, null, 2));

    const selection = loadSharedModelSelection({
      userDataPath,
      credentialStore: credentials.store,
    });
    assert.ok(selection);
    selection.persistOAuthTokens({
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 1_800_000_000_000,
      accountId: 'account-1',
    });

    const stored = JSON.parse(readFileSync(getSharedModelConfigPath(userDataPath), 'utf8')) as {
      version: number;
      channels: Array<{ id: string; oauthExpires?: number; oauthConfigured?: boolean; oauthAccountId?: string }>;
      models: Array<{ id: string; model: string }>;
    };
    assert.equal(stored.version, 2);
    assert.equal(stored.channels.length, 1);
    assert.equal(stored.models.length, 1);
    assert.equal(stored.channels[0]?.id, 'channel-oauth');
    assert.equal(stored.channels[0]?.oauthConfigured, true);
    assert.equal(stored.channels[0]?.oauthExpires, 1_800_000_000_000);
    assert.equal(stored.channels[0]?.oauthAccountId, 'account-1');
    assert.equal(stored.models[0]?.model, 'gpt-5');
    assert.equal(credentials.oauthTokens.get('channel-oauth')?.access, 'new-access');
    assert.equal(JSON.stringify(stored).includes('new-access'), false);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
