import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  modelApiKeyCredentialKey,
  modelOauthCredentialKey,
} from '@peer-agent/credential-helper';
import { createLlmConfigStore as createLlmConfigStoreImpl } from './llm-config-store.mjs';

const credentialStores = new Map();

function createMemoryCredentialClient(secrets) {
  return {
    getSecret(key) {
      return secrets.has(key) ? secrets.get(key) : null;
    },
    setSecret(key, value) {
      secrets.set(key, String(value));
    },
    deleteSecret(key) {
      return secrets.delete(key);
    },
  };
}

function createLlmConfigStore(options = {}) {
  const configFile = options.configFile;
  let secrets = credentialStores.get(configFile);
  if (!secrets) {
    secrets = new Map();
    credentialStores.set(configFile, secrets);
  }
  return createLlmConfigStoreImpl({
    ...options,
    credentialClient: options.credentialClient || createMemoryCredentialClient(secrets),
  });
}

function readPersistedModels(configFile) {
  const persisted = JSON.parse(readFileSync(configFile, 'utf8'));
  if (Array.isArray(persisted)) return persisted;
  const channels = new Map(persisted.channels.map((channel) => [channel.id || channel.groupId, channel]));
  return persisted.models.map((model) => ({
    ...channels.get(model.groupId),
    ...model,
  }));
}

function readPersistedChannels(configFile) {
  const persisted = JSON.parse(readFileSync(configFile, 'utf8'));
  if (Array.isArray(persisted)) {
    return [...new Map(persisted.map((model) => [model.groupId || model.id, model])).values()];
  }
  return persisted.channels;
}

function withStore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llm-config-store-'));
  const configFile = path.join(dir, 'llm-providers.json');
  const credentialSecrets = new Map();
  credentialStores.set(configFile, credentialSecrets);
  const cleanup = () => {
    credentialStores.delete(configFile);
    rmSync(dir, { recursive: true, force: true });
  };
  let cleanupNow = true;
  try {
    const result = fn({ dir, configFile, credentialSecrets });
    if (result && typeof result.then === 'function') {
      cleanupNow = false;
      return result.finally(cleanup);
    }
    return result;
  } finally {
    if (cleanupNow) cleanup();
  }
}

test('subscription provider creation applies gpt-5.5 pricing and context metadata', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });

  assert.equal(provider.model, 'gpt-5.5');
  assert.equal(provider.contextWindow, 258_000);
  assert.equal(provider.maxOutputTokens, 128_000);
  assert.equal(provider.inputPrice, 5);
  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.outputPrice, 30);
  assert.equal(provider.cacheWritePrice, undefined);
  assert.equal(provider.longContextInputThreshold, 258_000);
  assert.equal(provider.longContextInputPrice, 10);
  assert.equal(provider.longContextCacheReadPrice, 1);
  assert.equal(provider.longContextOutputPrice, 45);
  assert.equal(provider.supportsPromptCaching, true);
  assert.equal(provider.supportsReasoning, true);
}));

test('GPT-5.6 subscription model persists prompt cache and reasoning effort metadata', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'oauth_chatgpt',
    model: 'gpt-5.6-sol',
  });

  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.supportsPromptCaching, true);
  assert.deepEqual(provider.reasoningEffortLevels, ['low', 'default', 'high', 'max']);

  const reloaded = createLlmConfigStore({ configFile }).listProviders()
    .find((item) => item.id === provider.id);
  assert.equal(reloaded?.supportsPromptCaching, true);
  assert.deepEqual(reloaded?.reasoningEffortLevels, ['low', 'default', 'high', 'max']);
}));

test('subscription provider supports multiple configured models in one group', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const first = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });
  const second = store.addModel(first.groupId, {
    model: 'gpt-5.4',
    modelLabel: 'GPT-5.4',
    metadataSource: 'remote',
  });

  assert.equal(second.groupId, first.groupId);
  assert.equal(second.authMethod, 'oauth_chatgpt');
  assert.equal(second.model, 'gpt-5.4');
  assert.equal(second.modelLabel, 'GPT-5.4');
  assert.deepEqual(
    store.listProviders().map((provider) => provider.model),
    ['gpt-5.5', 'gpt-5.4'],
  );
}));

test('chat provider compatibility list returns configured records without catalog expansion', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const first = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });
  store.addModel(first.groupId, { model: 'gpt-5.4', modelLabel: 'GPT-5.4' });

  const configured = store.listProviders();
  const chat = store.listChatProviders();

  assert.deepEqual(chat.map((provider) => provider.id), configured.map((provider) => provider.id));
  assert.deepEqual(chat.map((provider) => provider.model), ['gpt-5.5', 'gpt-5.4']);
  assert.equal(new Set(chat.map((provider) => provider.id)).size, chat.length);
}));

test('subscription provider migration backfills pricing and context metadata', () => withStore(({ configFile }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'p1',
      provider: 'openai',
      authMethod: 'oauth_chatgpt',
      name: 'ChatGPT 订阅',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      apiKey: { encrypted: false, data: '' },
      oauthTokens: { encrypted: false, data: '' },
      enabled: true,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      contextWindow: 0,
      maxOutputTokens: 0,
      inputPrice: 0,
      outputPrice: 0,
      cacheWritePrice: 9,
      cacheReadPrice: 0,
      supportsReasoning: false,
      supportsPromptCaching: false,
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [provider] = store.listProviders();
  assert.equal(provider.contextWindow, 258_000);
  assert.equal(provider.maxOutputTokens, 128_000);
  assert.equal(provider.inputPrice, 5);
  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.outputPrice, 30);
  assert.equal(provider.cacheWritePrice, undefined);
  assert.equal(provider.longContextOutputPrice, 45);
  assert.equal(provider.supportsReasoning, true);
  assert.equal(provider.supportsPromptCaching, true);

  const persisted = readPersistedModels(configFile)[0];
  assert.equal(persisted.contextWindow, 258_000);
  assert.equal(persisted.maxOutputTokens, 128_000);
  assert.equal(persisted.inputPrice, 5);
  assert.equal(persisted.cacheWritePrice, undefined);
}));

test('subscription provider migration restores GPT-5.6 prompt cache and effort levels', () => withStore(({ configFile }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'sol',
      provider: 'openai',
      authMethod: 'oauth_chatgpt',
      name: 'ChatGPT 订阅',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.6-sol',
      enabled: true,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      supportsReasoning: true,
      supportsPromptCaching: false,
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [provider] = store.listProviders();
  assert.equal(provider.supportsPromptCaching, true);
  assert.deepEqual(provider.reasoningEffortLevels, ['low', 'default', 'high', 'max']);

  const [persisted] = readPersistedModels(configFile);
  assert.equal(persisted.supportsPromptCaching, true);
  assert.deepEqual(persisted.reasoningEffortLevels, ['low', 'default', 'high', 'max']);
}));

test('Grok OAuth records migrate to the official display name', () => withStore(({ configFile }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'grok-oauth',
      provider: 'openai',
      authMethod: 'oauth_grok',
      name: 'Grok 订阅',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      model: 'grok-4.5',
      enabled: true,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [provider] = store.listProviders();
  assert.equal(provider.name, 'Grok 官方');
  assert.equal(provider.channelId, 'grok');
  assert.equal(provider.authMethod, 'oauth_grok');

  const [persisted] = readPersistedModels(configFile);
  assert.equal(persisted.name, 'Grok 官方');
}));

test('legacy provider entries migrate to channel fields without losing stored settings', () => withStore(({ configFile, credentialSecrets }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'p1',
      provider: 'openai',
      authMethod: 'api_key',
      name: 'Custom gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      apiKey: { encrypted: false, data: 'secret-key' },
      oauthTokens: { encrypted: false, data: '' },
      enabled: false,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      contextWindow: 1234,
      maxOutputTokens: 5678,
      inputPrice: 1,
      outputPrice: 2,
      cacheReadPrice: 0.5,
      supportsVision: true,
      supportsReasoning: true,
      supportsPromptCaching: true,
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [provider] = store.listProviders();

  assert.equal(provider.channelId, 'openai-compatible');
  assert.equal(provider.resolvedWire, 'openai-chat');
  assert.equal(provider.name, 'Custom gateway');
  assert.equal(provider.baseUrl, 'https://gateway.example/v1');
  assert.equal(provider.model, 'model-a');
  assert.equal(provider.enabled, false);
  assert.equal(provider.isDefault, true);
  assert.equal(provider.contextWindow, 1234);
  assert.equal(provider.maxOutputTokens, 5678);
  assert.equal(provider.inputPrice, 1);
  assert.equal(provider.outputPrice, 2);
  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.supportsVision, true);
  assert.equal(provider.supportsReasoning, true);
  assert.equal(provider.supportsPromptCaching, true);
  assert.equal(provider.apiKeyConfigured, true);

  const persisted = readPersistedModels(configFile)[0];
  assert.equal(persisted.channelId, 'openai-compatible');
  assert.equal(Object.hasOwn(persisted, 'apiKey'), false);
  assert.equal(Object.hasOwn(persisted, 'oauthTokens'), false);
  assert.equal(persisted.apiKeyConfigured, true);
  assert.equal(persisted.apiKeyMasked, 'secr...-key');
  assert.equal(credentialSecrets.get('model/p1/api-key'), 'secret-key');
  assert.equal(store.getDecryptedApiKey('p1'), 'secret-key');
}));

test('manual provider creation and updates persist max output tokens', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'secret-key',
    maxOutputTokens: 8192,
  });

  assert.equal(provider.maxOutputTokens, 8192);

  const updated = store.updateProvider(provider.id, { maxOutputTokens: 4096 });
  assert.equal(updated.maxOutputTokens, 4096);

  const persisted = readPersistedModels(configFile)[0];
  assert.equal(persisted.maxOutputTokens, 4096);
}));

test('manual provider creation and updates persist reasoning effort maps', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'secret-key',
    supportsReasoning: true,
    reasoningParamStyle: 'openai-effort',
    reasoningEffortMap: {
      minimal: 'high',
      low: 'high',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
    },
  });

  assert.deepEqual(provider.reasoningEffortMap, {
    minimal: 'high',
    low: 'high',
    medium: 'high',
    high: 'high',
    xhigh: 'max',
  });

  const updated = store.updateProvider(provider.id, {
    reasoningEffortMap: { medium: 'high', xhigh: 'max' },
  });
  assert.deepEqual(updated.reasoningEffortMap, { medium: 'high', xhigh: 'max' });

  const persisted = readPersistedModels(configFile)[0];
  assert.deepEqual(persisted.reasoningEffortMap, { medium: 'high', xhigh: 'max' });
}));

test('Gemini subscription can be added without manual OAuth client configuration', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    channelId: 'google-ai',
    authMethod: 'oauth_google',
    name: 'Gemini OAuth',
    model: 'gemini-2.0-flash',
  });

  assert.equal(provider.channelId, 'google-ai');
  assert.equal(provider.authMethod, 'oauth_google');
  assert.equal(Object.hasOwn(provider, 'oauthClientId'), false);
  assert.equal(Object.hasOwn(provider, 'oauthClientSecretConfigured'), false);
}));

test('legacy Gemini OAuth client fields are discarded while the provider remains usable', () => withStore(({ configFile }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'legacy-gemini-oauth',
      provider: 'openai',
      channelId: 'google-ai',
      authMethod: 'oauth_google',
      name: 'Gemini OAuth',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash',
      apiKey: { encrypted: false, data: '' },
      oauthTokens: { encrypted: false, data: '' },
      oauthClientId: 'google-client-id',
      oauthClientSecret: { encrypted: false, data: 'google-client-secret' },
      oauthProjectId: 'my-project',
      enabled: true,
      isDefault: true,
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [provider] = store.listProviders();
  assert.equal(provider.id, 'legacy-gemini-oauth');
  assert.equal(provider.channelId, 'google-ai');
  assert.equal(provider.authMethod, 'oauth_google');
  assert.equal(Object.hasOwn(provider, 'oauthClientId'), false);
  assert.equal(Object.hasOwn(provider, 'oauthClientSecretConfigured'), false);
  assert.equal(provider.oauthProjectId, 'my-project');

  const credential = store.getCredential(provider.id);
  assert.equal(Object.hasOwn(credential, 'oauthClientId'), false);
  assert.equal(Object.hasOwn(credential, 'oauthClientSecret'), false);
  assert.equal(credential.oauthProjectId, 'my-project');
  const [persisted] = readPersistedModels(configFile);
  assert.equal(Object.hasOwn(persisted, 'oauthClientId'), false);
  assert.equal(Object.hasOwn(persisted, 'oauthClientSecret'), false);
}));

test('Qoder local auth provider does not require a stored API key', () => withStore(({ configFile, credentialSecrets }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    channelId: 'qoder',
    authMethod: 'qoder_local_auth',
    name: 'Qoder',
    model: 'auto',
  });

  assert.equal(provider.channelId, 'qoder');
  assert.equal(provider.resolvedWire, 'qoder-private');
  assert.equal(provider.authMethod, 'qoder_local_auth');
  assert.equal(provider.baseUrl, 'https://api2-v2.qoder.sh/model/v1');
  assert.equal(provider.model, 'auto');
  assert.equal(provider.modelLabel, 'Auto');
  assert.equal(provider.apiKeyConfigured, true);
  assert.equal(provider.apiKeyMasked, '');
  assert.equal(provider.contextWindow, 180000);
  assert.equal(provider.maxOutputTokens, 32768);
  assert.equal(provider.supportsVision, true);
  assert.equal(provider.supportsReasoning, false);

  const persisted = readPersistedModels(configFile)[0];
  assert.equal(Object.hasOwn(persisted, 'apiKey'), false);
  assert.equal(persisted.apiKeyConfigured, false);
  assert.equal(credentialSecrets.has(`model/${provider.groupId}/api-key`), false);
}));

test('Qoder local auth provider exposes catalog display label without changing request model id', () => withStore(({ configFile, dir }) => {
  const previousQoderConfigDir = process.env.QODER_CONFIG_DIR;
  const qoderDir = path.join(dir, '.qoder');
  mkdirSync(path.join(qoderDir, '.auth'), { recursive: true });
  writeFileSync(path.join(qoderDir, '.auth/models'), JSON.stringify({
    chat: [
      {
        key: 'gm51model',
        display_name: 'GLM-5.2',
        max_input_tokens: 1_000_000,
        max_output_tokens: 32_768,
        is_vl: true,
        is_reasoning: true,
        context_config: {
          '1M': { token_count: 1_000_000 },
          '200K': { token_count: 200_000, is_default: true },
        },
      },
    ],
  }), 'utf8');
  process.env.QODER_CONFIG_DIR = qoderDir;

  try {
    const store = createLlmConfigStore({ configFile });
    const provider = store.addProvider({
      provider: 'openai',
      channelId: 'qoder',
      authMethod: 'qoder_local_auth',
      name: 'Qoder',
      model: 'gm51model',
    });

    assert.equal(provider.model, 'gm51model');
    assert.equal(provider.modelLabel, 'GLM-5.2');
    assert.equal(provider.contextWindow, 1_000_000);
    assert.equal(provider.maxOutputTokens, 32_768);
    assert.equal(provider.supportsVision, true);
    assert.equal(provider.supportsReasoning, true);
  } finally {
    if (previousQoderConfigDir === undefined) delete process.env.QODER_CONFIG_DIR;
    else process.env.QODER_CONFIG_DIR = previousQoderConfigDir;
  }
}));

test('Qoder connection test probes the selected private chat model', async () => withStore(async ({ configFile }) => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.QODER_ACCESS_TOKEN;
  const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
  const previousQoderConfigDir = process.env.QODER_CONFIG_DIR;
  process.env.QODER_ACCESS_TOKEN = 'local-qoder-token';
  process.env.PEER_AGENT_PROVIDER_TRACE = '0';
  process.env.QODER_CONFIG_DIR = path.dirname(configFile);
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response([
      'event: error',
      'data: {"code":"invalid_model_error","message":"Unsupported model \\"gm51model\\"","type":"invalid_model_error"}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const store = createLlmConfigStore({ configFile });
    const provider = store.addProvider({
      provider: 'openai',
      channelId: 'qoder',
      authMethod: 'qoder_local_auth',
      name: 'Qoder',
      model: 'gm51model',
    });

    const result = await store.testConnection(provider.id);

    assert.equal(capturedBody.model, 'gm51model');
    assert.equal(result.success, false);
    assert.match(result.error, /Unsupported model "gm51model"/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.QODER_ACCESS_TOKEN;
    else process.env.QODER_ACCESS_TOKEN = previousToken;
    if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
    else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    if (previousQoderConfigDir === undefined) delete process.env.QODER_CONFIG_DIR;
    else process.env.QODER_CONFIG_DIR = previousQoderConfigDir;
  }
}));

test('legacy provider updates also update channel identity when channelId is omitted', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'secret-key',
  });

  const updated = store.updateProvider(provider.id, {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
  });

  assert.equal(updated.provider, 'anthropic');
  assert.equal(updated.channelId, 'anthropic');
  assert.equal(updated.resolvedWire, 'anthropic-messages');
}));

// ── B-2 多模型分组(groupId) ────────────────────────────────

test('addProvider without groupId makes each record its own group', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const p = store.addProvider({ provider: 'openai', authMethod: 'api_key', apiKey: 'k', model: 'model-a' });
  assert.equal(p.groupId, p.id, 'new provider self-groups (groupId === id)');
}));

test('legacy records migrate to self groups (groupId backfilled to id) and persist', () => withStore(({ configFile }) => {
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'legacy-1',
      provider: 'anthropic',
      authMethod: 'api_key',
      name: 'Legacy',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-x',
      apiKey: { encrypted: false, data: 'sk-legacy' },
      enabled: true,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ], null, 2));

  const store = createLlmConfigStore({ configFile });
  const [view] = store.listProviders();
  assert.equal(view.groupId, 'legacy-1', 'legacy record self-groups by its id');

  const persisted = readPersistedModels(configFile)[0];
  assert.equal(persisted.groupId, 'legacy-1', 'groupId backfill is written to disk');
}));

test('addModel adds a second model to the same group sharing credentials without re-entering apiKey', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const base = store.addProvider({
    provider: 'anthropic',
    authMethod: 'api_key',
    apiKey: 'shared-secret',
    baseUrl: 'https://api.anthropic.com',
    name: 'Anthropic',
    model: 'claude-opus',
  });

  const second = store.addModel(base.groupId, { model: 'claude-haiku', name: 'Anthropic Haiku' });

  // 同组、不同记录、不同模型
  assert.equal(second.groupId, base.groupId);
  assert.notEqual(second.id, base.id);
  assert.equal(second.model, 'claude-haiku');
  // provider 归属与凭证继承自组内首条:调用方未传 apiKey,底层密钥仍就绪
  assert.equal(second.provider, base.provider);
  assert.equal(second.baseUrl, base.baseUrl);
  assert.equal(store.getDecryptedApiKey(second.id), 'shared-secret');

  // 打平视图里同组现在有两条
  const grouped = store.listProviders().filter((p) => p.groupId === base.groupId);
  assert.equal(grouped.length, 2);
}));

test('addModel inherits connection fields without copying model metadata', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const base = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'shared-secret',
    baseUrl: 'https://example.test/v1',
    model: 'model-a',
    contextWindow: 128_000,
    inputPrice: 1,
    supportsVision: true,
    customHeaders: { 'X-Tenant': 'tenant-a' },
    metadataSource: 'remote',
    metadataSyncedAt: '2026-01-02T03:04:05.000Z',
  });

  const second = store.addModel(base.groupId, {
    model: 'model-b',
    metadataSource: 'models.dev',
    pricingSource: 'models.dev-reference',
    metadataSyncedAt: '2026-01-02T03:04:05.000Z',
  });

  assert.equal(second.baseUrl, base.baseUrl);
  assert.deepEqual(second.customHeaders, { 'X-Tenant': 'tenant-a' });
  assert.equal(store.getDecryptedApiKey(second.id), 'shared-secret');
  assert.equal(second.contextWindow, undefined);
  assert.equal(second.inputPrice, undefined);
  assert.equal(second.supportsVision, undefined);
  assert.equal(second.supportsReasoning, undefined);
  assert.equal(second.supportsPromptCaching, undefined);
  assert.equal(second.metadataSource, 'models.dev');
  assert.equal(second.pricingSource, 'models.dev-reference');
  const persistedSecond = createLlmConfigStore({ configFile }).listProviders()
    .find((item) => item.id === second.id);
  assert.equal(persistedSecond?.metadataSource, 'models.dev');
  assert.equal(persistedSecond?.pricingSource, 'models.dev-reference');

  const annotated = store.updateProvider(second.id, {
    modelLabel: 'Model B',
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    inputPrice: 1,
    outputPrice: 2,
    cacheWritePrice: 0.5,
    cacheReadPrice: 0.1,
    supportsVision: false,
    supportsReasoning: true,
    supportsPromptCaching: false,
    reasoningParamStyle: 'openai-effort',
    reasoningEffortMap: { low: 1024 },
  });
  assert.equal(annotated.supportsVision, false);
  assert.equal(annotated.supportsReasoning, true);

  const resetToUnknown = store.updateProvider(second.id, {
    modelLabel: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputPrice: null,
    outputPrice: null,
    cacheWritePrice: null,
    cacheReadPrice: null,
    supportsVision: null,
    supportsReasoning: null,
    supportsPromptCaching: null,
    reasoningParamStyle: null,
    reasoningEffortMap: null,
  });
  assert.equal(resetToUnknown.modelLabel, undefined);
  assert.equal(resetToUnknown.contextWindow, undefined);
  assert.equal(resetToUnknown.maxOutputTokens, undefined);
  assert.equal(resetToUnknown.inputPrice, undefined);
  assert.equal(resetToUnknown.outputPrice, undefined);
  assert.equal(resetToUnknown.cacheWritePrice, undefined);
  assert.equal(resetToUnknown.cacheReadPrice, undefined);
  assert.equal(resetToUnknown.supportsVision, undefined);
  assert.equal(resetToUnknown.supportsReasoning, undefined);
  assert.equal(resetToUnknown.supportsPromptCaching, undefined);
  assert.equal(resetToUnknown.reasoningParamStyle, undefined);
  assert.equal(resetToUnknown.reasoningEffortMap, undefined);

  const persisted = readPersistedModels(configFile).find((item) => item.id === second.id);
  for (const field of [
    'modelLabel',
    'contextWindow',
    'maxOutputTokens',
    'inputPrice',
    'outputPrice',
    'cacheWritePrice',
    'cacheReadPrice',
    'supportsVision',
    'supportsReasoning',
    'supportsPromptCaching',
    'reasoningParamStyle',
    'reasoningEffortMap',
  ]) {
    assert.equal(Object.hasOwn(persisted, field), false, `${field} removed from persisted record`);
  }

  assert.throws(
    () => store.addModel(base.groupId, { model: 'model-b' }),
    /already exists in provider group/,
  );
}));

test('removing the final model preserves its empty channel and credentials', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'oauth_grok',
    model: 'grok-4.5',
  });
  store.setOAuthTokens(provider.id, { access: 'grok-token', refresh: 'grok-refresh' });

  assert.equal(store.removeProvider(provider.id).length, 0);
  assert.equal(store.listGroups().length, 1);
  assert.equal(store.listGroups()[0].groupId, provider.groupId);
  assert.equal(readPersistedModels(configFile).length, 0);
  assert.equal(readPersistedChannels(configFile).length, 1);
  assert.equal(credentialSecrets.has(modelOauthCredentialKey(provider.groupId)), true);

  store.removeGroup(provider.groupId);
  assert.equal(store.listGroups().length, 0);
  assert.equal(readPersistedChannels(configFile).length, 0);
  assert.equal(credentialSecrets.has(modelOauthCredentialKey(provider.groupId)), false);
}));

test('removeGroup deletes every model in the group and reassigns default', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const g1 = store.addProvider({ provider: 'anthropic', authMethod: 'api_key', apiKey: 'k1', model: 'm1' });
  store.addModel(g1.groupId, { model: 'm2' });
  const g2 = store.addProvider({ provider: 'openai', authMethod: 'api_key', apiKey: 'k2', model: 'm3' });
  // g1 组是默认(首个创建),删掉整组后默认应转移到 g2
  store.setDefault(g1.id);

  const remaining = store.removeGroup(g1.groupId);
  assert.equal(remaining.length, 1, 'both models of g1 removed');
  assert.equal(remaining[0].groupId, g2.groupId);
  assert.equal(remaining[0].isDefault, true, 'default reassigned to surviving group');
}));

test('legacy safeStorage secrets migrate to Vault before encrypted fields are removed', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const expires = Date.now() + 60_000;
  const tokens = {
    access: 'legacy-access-token',
    refresh: 'legacy-refresh-token',
    expires,
    accountId: 'acct-legacy',
  };
  const encode = (value) => ({
    encrypted: true,
    data: Buffer.from(value, 'utf8').toString('base64'),
  });
  writeFileSync(configFile, JSON.stringify([{
    id: 'legacy-oauth',
    provider: 'openai',
    authMethod: 'oauth_google',
    name: 'Legacy OAuth',
    baseUrl: 'https://example.test/v1',
    model: 'legacy-model',
    apiKey: encode('legacy-api-key'),
    oauthClientId: 'legacy-client-id',
    oauthClientSecret: encode('legacy-client-secret'),
    oauthTokens: encode(JSON.stringify(tokens)),
    enabled: true,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  }], null, 2));

  let decryptCount = 0;
  const store = createLlmConfigStore({
    configFile,
    legacySecretDecryptor(stored) {
      decryptCount += 1;
      return Buffer.from(stored.data, 'base64').toString('utf8');
    },
  });

  const [provider] = store.listProviders();
  assert.equal(decryptCount, 2);
  assert.equal(provider.oauthStatus.status, 'connected');
  assert.equal(provider.oauthStatus.accountId, 'acct-legacy');
  assert.equal(credentialSecrets.get(modelApiKeyCredentialKey('legacy-oauth')), 'legacy-api-key');
  assert.deepEqual(
    JSON.parse(credentialSecrets.get(modelOauthCredentialKey('legacy-oauth'))),
    tokens,
  );

  const persistedText = readFileSync(configFile, 'utf8');
  const [persisted] = readPersistedChannels(configFile);
  for (const field of ['apiKey', 'oauthClientSecret', 'oauthTokens']) {
    assert.equal(Object.hasOwn(persisted, field), false, `${field} removed after verified migration`);
  }
  for (const secret of ['legacy-api-key', 'legacy-client-secret', 'legacy-access-token', 'legacy-refresh-token']) {
    assert.equal(persistedText.includes(secret), false, `${secret} absent from provider metadata`);
  }
  assert.equal(persisted.oauthConfigured, true);
  assert.equal(persisted.oauthExpires, expires);
  assert.equal(persisted.oauthAccountId, 'acct-legacy');
  assert.deepEqual(store.getCredential('legacy-oauth'), {
    tokens,
    oauthProjectId: undefined,
    authMethod: 'oauth_google',
  });

  store.listProviders();
  assert.equal(decryptCount, 2, 'migration is idempotent and legacy decrypt is not repeated');
}));

test('legacy credential migration failure preserves the source file and rolls Vault back', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const original = JSON.stringify([{
    id: 'legacy-failure',
    provider: 'openai',
    authMethod: 'api_key',
    name: 'Legacy failure',
    baseUrl: 'https://example.test/v1',
    model: 'legacy-model',
    apiKey: { encrypted: false, data: 'legacy-api-key' },
    oauthTokens: { encrypted: false, data: '{"access":"legacy-access"}' },
    enabled: true,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  }], null, 2);
  writeFileSync(configFile, original);

  let failTokenWrite = true;
  const credentialClient = {
    getSecret(key) {
      return credentialSecrets.has(key) ? credentialSecrets.get(key) : null;
    },
    setSecret(key, value) {
      if (failTokenWrite && key === modelOauthCredentialKey('legacy-failure')) {
        failTokenWrite = false;
        throw new Error('injected_credential_failure');
      }
      credentialSecrets.set(key, String(value));
    },
    deleteSecret(key) {
      return credentialSecrets.delete(key);
    },
  };
  const store = createLlmConfigStore({ configFile, credentialClient });

  assert.throws(() => store.listProviders(), /injected_credential_failure/);
  assert.equal(readFileSync(configFile, 'utf8'), original, 'legacy source remains byte-for-byte intact');
  assert.equal(credentialSecrets.size, 0, 'partial Vault writes are rolled back');
}));

test('provider listing uses non-sensitive metadata without unsealing Vault secrets', () => withStore(({
  configFile,
}) => {
  const secrets = new Map();
  let secretReads = 0;
  const credentialClient = {
    getSecret(key) {
      secretReads += 1;
      return secrets.has(key) ? secrets.get(key) : null;
    },
    setSecret(key, value) {
      secrets.set(key, String(value));
    },
    deleteSecret(key) {
      return secrets.delete(key);
    },
  };
  const store = createLlmConfigStore({ configFile, credentialClient });
  const provider = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'render-secret',
    model: 'model-a',
  });
  assert.equal(provider.apiKeyConfigured, true);

  secretReads = 0;
  const listed = store.listProviders();
  assert.equal(secretReads, 0, 'listProviders must not ask the Helper to reveal secrets');
  assert.equal(listed[0].apiKeyConfigured, true);
  assert.equal(listed[0].apiKeyMasked, 'rend...cret');
}));

test('OAuth token updates store only Vault ciphertext references and non-sensitive status metadata', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });
  const tokens = {
    access: 'oauth-access-secret',
    refresh: 'oauth-refresh-secret',
    expires: Date.now() + 60_000,
    accountId: 'acct-oauth',
  };

  const connected = store.setOAuthTokens(provider.id, tokens);
  assert.equal(connected.oauthStatus.status, 'connected');
  assert.equal(connected.oauthStatus.accountId, 'acct-oauth');
  assert.deepEqual(
    JSON.parse(credentialSecrets.get(modelOauthCredentialKey(provider.groupId))),
    tokens,
  );
  const persistedText = readFileSync(configFile, 'utf8');
  const [persisted] = readPersistedChannels(configFile);
  assert.equal(Object.hasOwn(persisted, 'oauthTokens'), false);
  assert.equal(persisted.oauthConfigured, true);
  assert.equal(persisted.oauthExpires, tokens.expires);
  assert.equal(persisted.oauthAccountId, 'acct-oauth');
  assert.equal(persistedText.includes(tokens.access), false);
  assert.equal(persistedText.includes(tokens.refresh), false);

  const disconnected = store.setOAuthTokens(provider.id, null);
  assert.equal(disconnected.oauthStatus.status, 'disconnected');
  assert.equal(credentialSecrets.has(modelOauthCredentialKey(provider.groupId)), false);
  const [cleared] = readPersistedModels(configFile);
  assert.equal(cleared.oauthConfigured, false);
  assert.equal(Object.hasOwn(cleared, 'oauthExpires'), false);
  assert.equal(Object.hasOwn(cleared, 'oauthAccountId'), false);
}));

test('legacy Google OAuth group migrates to API key without changing per-model metadata', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const groupId = 'legacy-google-group';
  const createdAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(configFile, JSON.stringify([
    {
      id: 'legacy-google-a',
      groupId,
      provider: 'openai',
      channelId: 'google-ai',
      authMethod: 'oauth_google',
      name: 'Legacy Gemini OAuth',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-a',
      modelLabel: 'Gemini A',
      contextWindow: 128_000,
      supportsVision: true,
      metadataSource: 'remote',
      metadataSyncedAt: createdAt,
      oauthConfigured: true,
      oauthExpires: Date.now() + 60_000,
      oauthAccountId: 'legacy-account',
      oauthClientId: 'legacy-client',
      oauthClientSecretConfigured: true,
      oauthProjectId: 'legacy-project',
      enabled: true,
      isDefault: true,
      createdAt,
    },
    {
      id: 'legacy-google-b',
      groupId,
      provider: 'openai',
      channelId: 'google-ai',
      authMethod: 'oauth_google',
      name: 'Legacy Gemini OAuth',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-b',
      modelLabel: 'Gemini B',
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      metadataSource: 'manual',
      metadataSyncedAt: createdAt,
      oauthConfigured: true,
      oauthExpires: Date.now() + 60_000,
      oauthAccountId: 'legacy-account',
      oauthClientId: 'legacy-client',
      oauthClientSecretConfigured: true,
      oauthProjectId: 'legacy-project',
      enabled: true,
      isDefault: false,
      createdAt,
    },
  ], null, 2));
  credentialSecrets.set(modelOauthCredentialKey(groupId), JSON.stringify({
    access: 'legacy-access',
    refresh: 'legacy-refresh',
    expires: Date.now() + 60_000,
    accountId: 'legacy-account',
  }));

  const store = createLlmConfigStore({ configFile });
  const connectionPatch = {
    provider: 'openai',
    channelId: 'google-ai',
    authMethod: 'api_key',
    name: 'Gemini API Key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  };
  store.updateProvider('legacy-google-a', { ...connectionPatch, apiKey: 'gemini-api-key' });
  store.updateProvider('legacy-google-b', connectionPatch);

  const migrated = store.listProviders();
  assert.equal(migrated.length, 2);
  for (const provider of migrated) {
    assert.equal(provider.authMethod, 'api_key');
    assert.equal(provider.apiKeyConfigured, true);
    assert.equal(provider.oauthStatus, undefined);
    assert.equal(Object.hasOwn(provider, 'oauthClientSecretConfigured'), false);
    assert.equal(store.getDecryptedApiKey(provider.id), 'gemini-api-key');
  }
  assert.equal(migrated[0].modelLabel, 'Gemini A');
  assert.equal(migrated[0].contextWindow, 128_000);
  assert.equal(migrated[0].supportsVision, true);
  assert.equal(migrated[0].metadataSource, 'remote');
  assert.equal(migrated[1].modelLabel, 'Gemini B');
  assert.equal(migrated[1].maxOutputTokens, 8_192);
  assert.equal(migrated[1].supportsReasoning, true);
  assert.equal(migrated[1].metadataSource, 'manual');
  assert.equal(credentialSecrets.has(modelOauthCredentialKey(groupId)), false);

  for (const persisted of readPersistedModels(configFile)) {
    assert.equal(Object.hasOwn(persisted, 'oauthExpires'), false);
    assert.equal(Object.hasOwn(persisted, 'oauthAccountId'), false);
    assert.equal(Object.hasOwn(persisted, 'oauthClientId'), false);
    assert.equal(Object.hasOwn(persisted, 'oauthProjectId'), false);
  }
}));

test('group members share one Vault key while duplicates and deletion keep independent lifecycles', () => withStore(({
  configFile,
  credentialSecrets,
}) => {
  const store = createLlmConfigStore({ configFile });
  const first = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'shared-original',
    model: 'model-a',
  });
  const second = store.addModel(first.groupId, { model: 'model-b' });
  const duplicate = store.duplicateProvider(first.id);

  assert.equal(store.getDecryptedApiKey(first.id), 'shared-original');
  assert.equal(store.getDecryptedApiKey(second.id), 'shared-original');
  assert.equal(store.getDecryptedApiKey(duplicate.id), 'shared-original');
  assert.notEqual(duplicate.groupId, first.groupId);

  store.updateProvider(first.id, { apiKey: 'shared-updated' });
  assert.equal(store.getDecryptedApiKey(second.id), 'shared-updated');
  assert.equal(store.getDecryptedApiKey(duplicate.id), 'shared-original');

  store.removeProvider(first.id);
  assert.equal(
    credentialSecrets.get(modelApiKeyCredentialKey(first.groupId)),
    'shared-updated',
    'removing one group member preserves the shared key',
  );
  store.removeGroup(first.groupId);
  assert.equal(credentialSecrets.has(modelApiKeyCredentialKey(first.groupId)), false);
  assert.equal(
    credentialSecrets.get(modelApiKeyCredentialKey(duplicate.groupId)),
    'shared-original',
    'deleting the source group does not delete the duplicate key',
  );
  store.removeGroup(duplicate.groupId);
  assert.equal(credentialSecrets.has(modelApiKeyCredentialKey(duplicate.groupId)), false);
}));

test('credential Helper failures abort writes without plaintext fallback', () => withStore(({ configFile }) => {
  const credentialClient = {
    getSecret() {
      throw new Error('credential_helper_unavailable');
    },
    setSecret() {
      throw new Error('credential_helper_unavailable');
    },
    deleteSecret() {
      throw new Error('credential_helper_unavailable');
    },
  };
  const store = createLlmConfigStore({ configFile, credentialClient });

  assert.throws(
    () => store.addProvider({
      provider: 'openai',
      authMethod: 'api_key',
      apiKey: 'must-never-be-plaintext',
      model: 'model-a',
    }),
    /credential_helper_unavailable/,
  );
  assert.equal(existsSync(configFile), false, 'provider metadata is not written after Helper failure');
}));

test('model option values persist per model and legacy configs remain readable', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const base = store.addProvider({
    provider: 'openai',
    authMethod: 'api_key',
    apiKey: 'sk-test',
    model: 'model-a',
    modelOptions: [{
      id: 'contextTier',
      label: 'Context',
      kind: 'select',
      defaultValue: '200K',
      choices: [{ value: '200K', label: '200K' }],
    }],
    modelOptionValues: { contextTier: '200K', retries: 2, streaming: true, ignored: null },
  });
  assert.deepEqual(base.modelOptions?.map((option) => option.id), ['contextTier']);
  assert.deepEqual(base.modelOptionValues, { contextTier: '200K', retries: 2, streaming: true });

  const updated = store.updateProvider(base.id, {
    modelOptions: [{
      id: 'contextTier',
      label: 'Context',
      kind: 'select',
      defaultValue: '400K',
      choices: [{ value: '400K', label: '400K' }],
    }],
    modelOptionValues: { contextTier: '1M', invalid: { nested: true } },
  });
  assert.equal(updated.modelOptions?.[0]?.defaultValue, '400K');
  assert.deepEqual(updated.modelOptionValues, { contextTier: '1M' });

  const second = store.addModel(base.groupId, {
    model: 'model-b',
    modelOptionValues: { contextTier: '400K' },
  });
  assert.deepEqual(second.modelOptionValues, { contextTier: '400K' });
  assert.deepEqual(store.listProviders().find((item) => item.id === base.id)?.modelOptionValues, { contextTier: '1M' });

  const persisted = readPersistedModels(configFile);
  assert.deepEqual(persisted.find((item) => item.id === base.id)?.modelOptionValues, { contextTier: '1M' });
  assert.deepEqual(persisted.find((item) => item.id === second.id)?.modelOptionValues, { contextTier: '400K' });

  delete persisted[0].modelOptionValues;
  writeFileSync(configFile, JSON.stringify(persisted, null, 2), 'utf8');
  assert.equal(store.listProviders().find((item) => item.id === persisted[0].id)?.modelOptionValues, undefined);
}));
