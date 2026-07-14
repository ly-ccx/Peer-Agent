import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createLlmConfigStore } from './llm-config-store.mjs';

function withStore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llm-config-store-'));
  const configFile = path.join(dir, 'llm-providers.json');
  let cleanupNow = true;
  try {
    const result = fn({ dir, configFile });
    if (result && typeof result.then === 'function') {
      cleanupNow = false;
      return result.finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    return result;
  } finally {
    if (cleanupNow) rmSync(dir, { recursive: true, force: true });
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
  assert.equal(persisted.contextWindow, 258_000);
  assert.equal(persisted.maxOutputTokens, 128_000);
  assert.equal(persisted.inputPrice, 5);
  assert.equal(persisted.cacheWritePrice, undefined);
}));

test('legacy provider entries migrate to channel fields without losing stored settings', () => withStore(({ configFile }) => {
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
  assert.equal(persisted.channelId, 'openai-compatible');
  assert.deepEqual(persisted.apiKey, { encrypted: false, data: 'secret-key' });
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
  assert.deepEqual(persisted.reasoningEffortMap, { medium: 'high', xhigh: 'max' });
}));

test('Gemini OAuth can no longer be added', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  assert.throws(
    () => store.addProvider({
      provider: 'openai',
      channelId: 'google-ai',
      authMethod: 'oauth_google',
      name: 'Gemini OAuth',
      model: 'gemini-2.0-flash',
      oauthClientId: 'google-client-id',
      oauthClientSecret: 'google-client-secret',
      oauthProjectId: 'my-project',
    }),
    /unsupported_auth_method:google-ai:oauth_google/,
  );
}));

test('legacy Gemini OAuth records remain readable for migration or deletion', () => withStore(({ configFile }) => {
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
  assert.equal(provider.oauthClientId, 'google-client-id');
  assert.equal(provider.oauthClientSecretConfigured, true);
  assert.equal(provider.oauthProjectId, 'my-project');

  const credential = store.getCredential(provider.id);
  assert.equal(credential.oauthClientId, 'google-client-id');
  assert.equal(credential.oauthClientSecret, 'google-client-secret');
  assert.equal(credential.oauthProjectId, 'my-project');
}));

test('Qoder local auth provider does not require a stored API key', () => withStore(({ configFile }) => {
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
  assert.deepEqual(persisted.apiKey, { encrypted: false, data: '' });
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

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
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

test('addModel refuses subscription (OAuth) providers', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const sub = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });
  assert.throws(() => store.addModel(sub.groupId, { model: 'gpt-x' }), /multiple models/);
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
