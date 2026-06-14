import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FALLBACK_MODELS,
  isChatModel,
  isSubscriptionUsableModel,
  listSubscriptionModels,
  sortNewestFirst,
} from './openai-model-catalog.mjs';

test('isChatModel keeps gpt/o families, drops non-chat', () => {
  assert.equal(isChatModel('gpt-5-codex'), true);
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

test('listSubscriptionModels falls back when no access token', async () => {
  const res = await listSubscriptionModels({});
  assert.equal(res.source, 'fallback');
  assert.equal(res.models[0].id, FALLBACK_MODELS[0].id);
});

test('listSubscriptionModels falls back on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const res = await listSubscriptionModels({ access: 'tok' }, { fetchImpl });
  assert.equal(res.source, 'fallback');
  assert.match(res.error, /401/);
});

test('isSubscriptionUsableModel keeps gpt-5 family, drops API-only models', () => {
  assert.equal(isSubscriptionUsableModel('gpt-5'), true);
  assert.equal(isSubscriptionUsableModel('gpt-5-codex'), true);
  assert.equal(isSubscriptionUsableModel('gpt-4o'), false);
  assert.equal(isSubscriptionUsableModel('o3'), false);
  assert.equal(isSubscriptionUsableModel('o4-mini'), false);
  assert.equal(isSubscriptionUsableModel(undefined), false);
});

test('listSubscriptionModels keeps only subscription-usable models newest-first', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        { id: 'gpt-4o', created: 100 },
        { id: 'text-embedding-3-large', created: 999 },
        { id: 'gpt-5-codex', created: 300 },
        { id: 'o3', created: 200 },
        { id: 'gpt-5', created: 250 },
      ],
    }),
  });
  const res = await listSubscriptionModels({ access: 'tok', accountId: 'acct' }, { fetchImpl });
  assert.equal(res.source, 'remote');
  // gpt-4o / o3 被订阅白名单过滤掉,只保留 gpt-5 家族,按 created 降序。
  assert.deepEqual(res.models.map((m) => m.id), ['gpt-5-codex', 'gpt-5']);
});

test('listSubscriptionModels falls back when remote has no subscription-usable models', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'o3' }, { id: 'whisper-1' }] }),
  });
  const res = await listSubscriptionModels({ access: 'tok' }, { fetchImpl });
  assert.equal(res.source, 'fallback');
});

test('listSubscriptionModels sends auth + account headers', async () => {
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = init;
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-5', created: 1 }] }) };
  };
  await listSubscriptionModels({ access: 'tok123', accountId: 'acct9' }, { fetchImpl });
  assert.equal(seen.headers.Authorization, 'Bearer tok123');
  assert.equal(seen.headers['chatgpt-account-id'], 'acct9');
});
