import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUBSCRIPTION_CATALOG,
  FALLBACK_MODELS,
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
  isChatModel,
  isSubscriptionUsableModel,
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
  assert.equal(model.contextWindow, 258_000);
  assert.equal(model.maxOutputTokens, 128_000);
  assert.equal(model.inputPrice, 5);
  assert.equal(model.cacheReadPrice, 0.5);
  assert.equal(model.outputPrice, 30);
  assert.equal(model.longContextInputThreshold, 258_000);
  assert.equal(model.longContextInputPrice, 10);
  assert.equal(model.longContextCacheReadPrice, 1);
  assert.equal(model.longContextOutputPrice, 45);
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
  assert.equal(res.models[0].contextWindow, 258_000);
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
