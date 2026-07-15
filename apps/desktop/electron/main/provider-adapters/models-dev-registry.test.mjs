import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODELS_DEV_URL,
  buildModelsDevIndex,
  enrichModelsWithRegistry,
  fetchModelsDevRegistry,
  resetModelsDevRegistryCacheForTests,
} from './models-dev-registry.mjs';

const registryPayload = {
  openai: {
    models: {
      'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT 5.6 Terra',
        reasoning: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1_050_000, output: 128_000 },
        cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 },
      },
    },
  },
};

test('normalizes models.dev metadata and enriches only exact model IDs', () => {
  const registry = buildModelsDevIndex(registryPayload);
  const enriched = enrichModelsWithRegistry([
    { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { id: 'gpt-5.6-terra-preview', label: 'gpt-5.6-terra-preview' },
  ], registry);

  assert.deepEqual(enriched[0], {
    id: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsReasoning: true,
    inputPrice: 2.5,
    outputPrice: 15,
    cacheReadPrice: 0.25,
    cacheWritePrice: 3.125,
    metadataSource: 'models.dev',
    pricingSource: 'models.dev-reference',
  });
  assert.deepEqual(enriched[1], { id: 'gpt-5.6-terra-preview', label: 'gpt-5.6-terra-preview' });
});

test('provider catalog fields take priority over models.dev fallback fields', () => {
  const [model] = enrichModelsWithRegistry([{
    id: 'gpt-5.6-terra',
    label: 'Gateway Terra',
    contextWindow: 999,
    inputPrice: 0.1,
    supportsVision: false,
  }], buildModelsDevIndex(registryPayload));

  assert.equal(model.label, 'Gateway Terra');
  assert.equal(model.contextWindow, 999);
  assert.equal(model.inputPrice, 0.1);
  assert.equal(model.supportsVision, false);
  assert.equal(model.maxOutputTokens, 128_000);
});

test('registry client caches successful responses', async () => {
  resetModelsDevRegistryCacheForTests();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, MODELS_DEV_URL);
    return { ok: true, json: async () => registryPayload };
  };

  const first = await fetchModelsDevRegistry({ fetchImpl, now: () => 100 });
  const second = await fetchModelsDevRegistry({ fetchImpl, now: () => 101 });
  assert.equal(first.get('gpt-5.6-terra').contextWindow, 1_050_000);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('registry client degrades to an empty registry on network failure', async () => {
  resetModelsDevRegistryCacheForTests();
  const registry = await fetchModelsDevRegistry({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(registry.size, 0);
});
