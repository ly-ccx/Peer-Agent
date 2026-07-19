import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODELS_DEV_URL,
  buildModelsDevIndex,
  canonicalizeModelId,
  enrichModelsWithRegistry,
  fetchModelsDevRegistry,
  fillMissingPricingFromRegistry,
  lookupModelsDevMetadata,
  resetModelsDevRegistryCacheForTests,
} from './models-dev-registry.mjs';

const registryPayload = {
  openai: {
    models: {
      'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT 5.6 Terra',
        reasoning: true,
        modalities: { input: ['text', 'image'] },
        limit: { context: 200_000, output: 64_000 },
        cost: { input: 5, output: 15, cache_read: 0.5, cache_write: 6.25 },
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT 5.4',
        cost: { input: 2.5, output: 10, cache_read: 0.25 },
      },
    },
  },
};

test('buildModelsDevIndex indexes exact and canonical ids', () => {
  const index = buildModelsDevIndex(registryPayload);
  assert.equal(index.get('gpt-5.6-terra')?.inputPrice, 5);
  assert.equal(index.get(canonicalizeModelId('GPT-5.6-Terra'))?.outputPrice, 15);
  assert.equal(index.get('gpt54')?.inputPrice, 2.5);
});

test('lookupModelsDevMetadata resolves normalized ids', () => {
  const index = buildModelsDevIndex(registryPayload);
  assert.equal(lookupModelsDevMetadata(index, 'gpt-5.4')?.inputPrice, 2.5);
  assert.equal(lookupModelsDevMetadata(index, 'GPT_5_4')?.outputPrice, 10);
  assert.equal(lookupModelsDevMetadata(index, 'missing-model'), undefined);
});

test('enrichModelsWithRegistry fills missing fields without clobbering provider pricing', () => {
  const index = buildModelsDevIndex(registryPayload);
  const [enriched] = enrichModelsWithRegistry(
    [{ id: 'gpt-5.6-terra', inputPrice: 9, pricingSource: 'provider' }],
    index,
  );
  assert.equal(enriched.inputPrice, 9);
  assert.equal(enriched.outputPrice, 15);
  assert.equal(enriched.pricingSource, 'provider');
  assert.equal(enriched.metadataSource, 'models.dev');
});

test('enrichModelsWithRegistry matches canonical model ids', () => {
  const index = buildModelsDevIndex(registryPayload);
  const [enriched] = enrichModelsWithRegistry([{ id: 'GPT-5_4' }], index);
  assert.equal(enriched.inputPrice, 2.5);
  assert.equal(enriched.pricingSource, 'models.dev-reference');
});

test('fillMissingPricingFromRegistry only fills blank price fields', () => {
  const index = buildModelsDevIndex(registryPayload);
  const { item, changed } = fillMissingPricingFromRegistry(
    {
      model: 'gpt-5.6-terra',
      inputPrice: 9,
      // output/cache missing
    },
    index,
  );
  assert.equal(changed, true);
  assert.equal(item.inputPrice, 9);
  assert.equal(item.outputPrice, 15);
  assert.equal(item.cacheReadPrice, 0.5);
  assert.equal(item.cacheWritePrice, 6.25);
  assert.equal(item.pricingSource, 'models.dev-reference');
});

test('fillMissingPricingFromRegistry skips provider-owned pricing', () => {
  const index = buildModelsDevIndex(registryPayload);
  const { item, changed } = fillMissingPricingFromRegistry(
    {
      model: 'gpt-5.6-terra',
      pricingSource: 'provider',
    },
    index,
  );
  assert.equal(changed, false);
  assert.equal(item.inputPrice, undefined);
});

test('fetchModelsDevRegistry uses MODELS_DEV_URL and caches result', async () => {
  resetModelsDevRegistryCacheForTests();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, MODELS_DEV_URL);
    return {
      ok: true,
      json: async () => registryPayload,
    };
  };
  const first = await fetchModelsDevRegistry({ fetchImpl, cacheTtlMs: 60_000 });
  const second = await fetchModelsDevRegistry({ fetchImpl, cacheTtlMs: 60_000 });
  assert.equal(calls, 1);
  assert.equal(first.get('gpt-5.6-terra')?.label, 'GPT 5.6 Terra');
  assert.equal(second.get('gpt-5.6-terra')?.label, 'GPT 5.6 Terra');
});

test('registry client degrades to an empty registry on network failure', async () => {
  resetModelsDevRegistryCacheForTests();
  const registry = await fetchModelsDevRegistry({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(registry.size, 0);
});
