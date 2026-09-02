import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUBSCRIPTION_CATALOG,
  FALLBACK_MODELS,
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
  isChatModel,
  isLikelyChatModel,
  normalizeApiModelList,
  isSubscriptionUsableModel,
  listOpenAICompatibleModels,
  listModelCatalogForChannel,
  listSubscriptionModels,
  sortNewestFirst,
} from './openai-model-catalog.mjs';

test('isChatModel keeps gpt/o families, drops non-chat', () => {
  assert.equal(isChatModel('gpt-5.5'), true);
  assert.equal(isChatModel('gpt-4o'), true);
  assert.equal(isChatModel('o3'), true);
  assert.equal(isChatModel('chatgpt-4o-latest'), true);
  assert.equal(isChatModel('text-embedding-3-large'), false);
  assert.equal(isChatModel('whisper-1'), false);
  assert.equal(isChatModel('dall-e-3'), false);
  assert.equal(isChatModel('gpt-4o-transcribe'), false);
  assert.equal(isChatModel(undefined), false);
});

test('sortNewestFirst orders by created desc, missing last', () => {
  const sorted = sortNewestFirst([
    { id: 'a', created: 100 },
    { id: 'b' },
    { id: 'c', created: 300 },
    { id: 'd', created: 200 },
  ]);
  assert.deepEqual(sorted.map((m) => m.id), ['c', 'd', 'a', 'b']);
});

test('subscription catalog: default is newest (gpt-5.5) and first entry', () => {
  assert.equal(DEFAULT_SUBSCRIPTION_MODEL, 'gpt-5.5');
  assert.equal(SUBSCRIPTION_CATALOG[0].id, 'gpt-5.5');
  // FALLBACK_MODELS 是同一份清单的兼容别名。
  assert.equal(FALLBACK_MODELS, SUBSCRIPTION_CATALOG);
});

test('subscription catalog includes gpt-5.5 pricing and context metadata', () => {
  const model = getSubscriptionModelMetadata('gpt-5.5');
  assert.ok(model);
  assert.equal(model.contextWindow, 272_000);
  assert.equal(model.maxOutputTokens, 128_000);
  assert.equal(model.inputPrice, 5);
  assert.equal(model.cacheReadPrice, 0.5);
  assert.equal(model.outputPrice, 30);
  assert.equal(model.longContextInputThreshold, 272_000);
  assert.equal(model.longContextInputPrice, 10);
  assert.equal(model.longContextCacheReadPrice, 1);
  assert.equal(model.longContextOutputPrice, 45);
});

test('GPT-5.6 subscription models expose cache pricing and max reasoning', () => {
  const expected = new Map([
    ['gpt-5.6-sol', { inputPrice: 5, cacheReadPrice: 0.5, outputPrice: 30 }],
    ['gpt-5.6-terra', { inputPrice: 2.5, cacheReadPrice: 0.25, outputPrice: 15 }],
    ['gpt-5.6-luna', { inputPrice: 1, cacheReadPrice: 0.1, outputPrice: 6 }],
  ]);
  for (const [id, pricing] of expected) {
    const model = getSubscriptionModelMetadata(id);
    assert.ok(model);
    assert.equal(model.contextWindow, 272_000);
    assert.equal(model.inputPrice, pricing.inputPrice);
    assert.equal(model.cacheReadPrice, pricing.cacheReadPrice);
    assert.equal(model.outputPrice, pricing.outputPrice);
    assert.equal(model.supportsPromptCaching, true);
    assert.deepEqual(model.reasoningEffortLevels, ['low', 'default', 'high', 'xhigh', 'max']);
  }
});

test('subscription model id set covers the catalog, excludes API-only ids', () => {
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.5'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.6-sol'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.6-terra'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.6-luna'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.4'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.4-mini'), true);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5.3-codex-spark'), true);
  // 旧的按量计费命名不在订阅集合内,触发迁移。
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5'), false);
  assert.equal(SUBSCRIPTION_MODEL_IDS.has('gpt-5-codex'), false);
});

test('listSubscriptionModels returns built-in authoritative catalog (no network)', async () => {
  // codex 订阅平面无列模型接口:内置清单即权威目录,source='builtin',永不发起请求。
  const res = await listSubscriptionModels({ access: 'tok', accountId: 'acct' });
  assert.equal(res.source, 'builtin');
  assert.equal(res.error, undefined);
  assert.equal(res.models[0].contextWindow, 272_000);
  assert.equal(res.models[0].inputPrice, 5);
  assert.equal(res.models[0].longContextOutputPrice, 45);
  assert.deepEqual(
    res.models.map((m) => m.id),
    [
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ],
  );
});

test('listSubscriptionModels returns a copy (caller cannot mutate catalog)', async () => {
  const res = await listSubscriptionModels({});
  res.models.push({ id: 'x', label: 'x' });
  assert.equal(SUBSCRIPTION_CATALOG.length, 7);
});

test('isSubscriptionUsableModel keeps gpt-5 family, drops API-only models', () => {
  assert.equal(isSubscriptionUsableModel('gpt-5.5'), true);
  assert.equal(isSubscriptionUsableModel('gpt-5.4-mini'), true);
  assert.equal(isSubscriptionUsableModel('gpt-4o'), false);
  assert.equal(isSubscriptionUsableModel('o3'), false);
  assert.equal(isSubscriptionUsableModel('o4-mini'), false);
  assert.equal(isSubscriptionUsableModel(undefined), false);
});

test('isLikelyChatModel keeps third-party chat ids, drops known non-chat ids', () => {
  assert.equal(isLikelyChatModel('deepseek-chat'), true);
  assert.equal(isLikelyChatModel('qwen-max'), true);
  assert.equal(isLikelyChatModel('moonshot-v1-128k'), true);
  assert.equal(isLikelyChatModel('text-embedding-3-large'), false);
  assert.equal(isLikelyChatModel('bge-reranker-v2-m3'), false);
  assert.equal(isLikelyChatModel('whisper-1'), false);
});

test('normalizeApiModelList handles OpenAI-compatible and Gemini payloads', () => {
  assert.deepEqual(
    normalizeApiModelList({ data: [{ id: 'deepseek-chat', created: 300 }, { id: 'text-embedding-3-large', created: 400 }] }, 'openai-chat'),
    [
      { id: 'deepseek-chat', label: 'deepseek-chat', created: 300 },
      { id: 'text-embedding-3-large', label: 'text-embedding-3-large', created: 400 },
    ],
  );
  assert.deepEqual(
    normalizeApiModelList({
      models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 100, outputTokenLimit: 20, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    }, 'gemini'),
    [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 100, maxOutputTokens: 20 }],
  );
});

test('listOpenAICompatibleModels fetches /models, strips content-type, filters non-chat and sorts newest', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const res = await listOpenAICompatibleModels({
    baseUrl: 'https://example.test/v1/',
    wire: 'openai-chat',
    headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json', 'X-Custom': '1' },
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'old-chat', created: 100 },
            { id: 'text-embedding-3-large', created: 999 },
            { id: 'new-chat', created: 300 },
          ],
        }),
      };
    },
  });
  assert.equal(seenUrl, 'https://example.test/v1/models');
  assert.equal(seenHeaders.Authorization, 'Bearer key');
  assert.equal(seenHeaders['X-Custom'], '1');
  assert.equal(seenHeaders['Content-Type'], undefined);
  assert.equal(res.source, 'remote');
  assert.deepEqual(res.models.map((m) => m.id), ['new-chat', 'old-chat']);
});

test('listOpenAICompatibleModels requests the DeepSeek official catalog with Bearer auth', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const res = await listOpenAICompatibleModels({
    baseUrl: 'https://api.deepseek.com',
    wire: 'openai-chat',
    headers: { Authorization: 'Bearer deepseek-test-key', 'Content-Type': 'application/json' },
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'deepseek-chat' },
            { id: 'deepseek-reasoner' },
            { id: 'deepseek-embedding' },
          ],
        }),
      };
    },
  });

  assert.equal(seenUrl, 'https://api.deepseek.com/models');
  assert.equal(seenHeaders.Authorization, 'Bearer deepseek-test-key');
  assert.equal(seenHeaders['Content-Type'], undefined);
  assert.equal(res.source, 'remote');
  assert.deepEqual(res.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
});

test('listOpenAICompatibleModels enriches exact IDs while preserving provider fields', async () => {
  const res = await listOpenAICompatibleModels({
    baseUrl: 'https://example.test/v1',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-5.6-terra', contextWindow: 999 }] }),
    }),
    registryFetchImpl: async () => ({
      ok: true,
      json: async () => ({
        custom: {
          models: {
            'gpt-5.6-terra': {
              id: 'gpt-5.6-terra',
              name: 'GPT 5.6 Terra',
              reasoning: true,
              modalities: { input: ['text', 'image'] },
              limit: { context: 1_050_000, output: 128_000 },
              cost: { input: 2.5, output: 15 },
            },
          },
        },
      }),
    }),
  });

  assert.deepEqual(res.models, [{
    id: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    contextWindow: 999,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsReasoning: true,
    inputPrice: 2.5,
    outputPrice: 15,
    metadataSource: 'provider',
    pricingSource: 'models.dev-reference',
  }]);
});

test('listOpenAICompatibleModels keeps provider catalog when registry fetch fails', async () => {
  const res = await listOpenAICompatibleModels({
    baseUrl: 'https://example.test/v1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'unknown-chat' }] }) }),
    registryFetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(res.models, [{ id: 'unknown-chat', label: 'unknown-chat' }]);
});

test('listOpenAICompatibleModels rewrites DeepSeek Anthropic chat roots to the OpenAI catalog URL', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const res = await listOpenAICompatibleModels({
    baseUrl: 'https://api.deepseek.com/anthropic',
    wire: 'anthropic-messages',
    apiKey: 'deepseek-test-key',
    headers: { 'x-api-key': 'deepseek-test-key', 'anthropic-version': '2023-06-01' },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      };
    },
  });
  assert.equal(seenUrl, 'https://api.deepseek.com/models');
  assert.doesNotMatch(seenUrl, /\/anthropic\/v1\/models/);
  assert.equal(seenHeaders.Authorization, 'Bearer deepseek-test-key');
  assert.equal(seenHeaders['x-api-key'], undefined);
  assert.equal(seenHeaders['anthropic-version'], undefined);
  assert.equal(res.source, 'remote');
  assert.deepEqual(res.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
});

test('listOpenAICompatibleModels derives Anthropic and Gemini model endpoints', async () => {
  const urls = [];
  const okResponse = { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-4-5', created_at: '2025-01-01T00:00:00Z' }] }) };
  await listOpenAICompatibleModels({
    baseUrl: 'https://api.anthropic.com',
    wire: 'anthropic-messages',
    headers: { 'x-api-key': 'key' },
    fetchImpl: async (url) => { urls.push(url); return okResponse; },
  });
  await listOpenAICompatibleModels({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    wire: 'gemini',
    apiKey: 'a b',
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }) };
    },
  });
  assert.deepEqual(urls, [
    'https://api.anthropic.com/v1/models',
    'https://generativelanguage.googleapis.com/v1beta/models?key=a%20b',
  ]);
});

test('listOpenAICompatibleModels throws clear HTTP error', async () => {
  await assert.rejects(
    listOpenAICompatibleModels({
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
    }),
    /models list failed: HTTP 401 bad key/,
  );
});

test('listModelCatalogForChannel routes DeepSeek catalog to the OpenAI plane with Bearer auth', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const res = await listModelCatalogForChannel({
    baseUrl: 'https://api.deepseek.com/anthropic',
    wire: 'anthropic-messages',
    headers: { 'x-api-key': 'deepseek-test-key', 'anthropic-version': '2023-06-01' },
    modelCatalog: {
      channelId: 'deepseek',
      wire: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      headers: { Authorization: 'Bearer deepseek-test-key' },
    },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      };
    },
  });
  assert.equal(seenUrl, 'https://api.deepseek.com/models');
  assert.doesNotMatch(seenUrl, /\/anthropic\/v1\/models/);
  assert.equal(seenHeaders.Authorization, 'Bearer deepseek-test-key');
  assert.equal(seenHeaders['x-api-key'], undefined);
  assert.equal(seenHeaders['anthropic-version'], undefined);
  assert.equal(seenHeaders['Content-Type'], undefined);
  assert.equal(res.source, 'remote');
  assert.deepEqual(res.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
});

test('listModelCatalogForChannel still rewrites DeepSeek Anthropic roots when catalog override is missing', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const res = await listModelCatalogForChannel({
    baseUrl: 'https://api.deepseek.com/anthropic',
    wire: 'anthropic-messages',
    apiKey: 'deepseek-test-key',
    headers: { 'x-api-key': 'deepseek-test-key', 'anthropic-version': '2023-06-01' },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      };
    },
  });
  assert.equal(seenUrl, 'https://api.deepseek.com/models');
  assert.doesNotMatch(seenUrl, /\/anthropic\/v1\/models/);
  assert.equal(seenHeaders.Authorization, 'Bearer deepseek-test-key');
  assert.equal(seenHeaders['x-api-key'], undefined);
  assert.equal(res.source, 'remote');
});

test('listModelCatalogForChannel falls back to the built-in DeepSeek catalog and keeps the error', async () => {
  const res = await listModelCatalogForChannel({
    baseUrl: 'https://api.deepseek.com/anthropic',
    wire: 'anthropic-messages',
    modelCatalog: {
      channelId: 'deepseek',
      wire: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      headers: { Authorization: 'Bearer deepseek-test-key' },
    },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'not found' }),
  });
  assert.equal(res.source, 'fallback');
  assert.equal(res.error, 'models list failed: HTTP 404 not found');
  assert.deepEqual(res.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
});

test('listModelCatalogForChannel keeps plain remote failure for channels without a catalog override', async () => {
  await assert.rejects(
    listModelCatalogForChannel({
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    }),
    /models list failed: HTTP 500 boom/,
  );
});
