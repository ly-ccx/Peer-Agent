import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GROK_BUILD_BASE_URL,
  buildGrokBuildHeaders,
  listGrokBuildModels,
} from './grok-build-model-catalog.mjs';

describe('Grok Build model catalog', () => {
  it('loads models with Grok CLI subscription headers', async () => {
    let request = null;
    const result = await listGrokBuildModels('access-token', {
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({ data: [{
          id: 'grok-4.5',
          display_name: 'Grok 4.5',
          context_window: 500000,
          supports_reasoning: true,
          supported_reasoning_efforts: ['low', 'medium', 'high'],
        }] }), { status: 200 });
      },
    });

    assert.equal(request.url, `${GROK_BUILD_BASE_URL}/models`);
    assert.equal(request.init.headers.Authorization, 'Bearer access-token');
    assert.equal(request.init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(request.init.headers['x-grok-client-surface'], 'grok-build');
    assert.equal(result.source, 'remote');
    assert.equal(result.models[0].id, 'grok-4.5');
    assert.equal(result.models[0].contextWindow, 500000);
  });

  it('returns the built-in Grok model when live catalog fails', async () => {
    const result = await listGrokBuildModels('access-token', {
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(result.source, 'builtin');
    assert.equal(result.error, 'offline');
    assert.equal(result.models[0].id, 'grok-4.5');
  });

  it('builds immutable Grok CLI identity headers', () => {
    const headers = buildGrokBuildHeaders('token');
    assert.equal(headers.Authorization, 'Bearer token');
    assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.ok(headers['x-grok-client-version']);
  });
});
