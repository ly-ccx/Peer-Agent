// Separate process: mock only the auth preparation seam, never the routing adapter.
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const authUrl = new URL('../../../../../packages/runtime-node/dist/provider-adapters/qoder-local-auth.mjs', import.meta.url);
const catalogUrl = new URL('../../../../../packages/runtime-node/dist/provider-adapters/qoder-model-catalog.mjs', import.meta.url);
const auth = await import(authUrl.href);
const catalog = await import(catalogUrl.href);
const preparedRequests = [];
mock.module(authUrl.href, {
  namedExports: {
    ...auth,
    prepareQoderInferRequest: async (request) => {
      preparedRequests.push(request);
      return {
        url: `${request.endpoint}/agent_chat_generation`,
        headers: { Authorization: 'Bearer isolated-test-token' },
        body: JSON.stringify(request.requestBody),
      };
    },
  },
});
mock.module(catalogUrl.href, {
  namedExports: { ...catalog, getQoderModelMetadata: () => null },
});

// Import the real Desktop adapter after mocks, including its shared built runtime.
const { sendQoderPrivateStream } = await import('./qoder-private-adapter.mjs');
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return new Response([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: [DONE]', '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const result = await sendQoderPrivateStream({
  baseUrl: 'https://example.test/model/v1', endpoint: 'https://example.test',
  apiKey: 'token', model: 'kmodel_latest',
  messages: [{ role: 'user', content: 'hi' }],
  modelOptions: [{
    id: 'contextTier', kind: 'select',
    choices: [{ value: '1M', contextWindow: 1_000_000, inputTokenLimit: 980_000 }],
  }],
  modelOptionValues: { contextTier: '1M' },
  webContents: { send() {} }, streamId: 's-qoder-fallback-options',
});
assert.equal(result.ok, true);
assert.equal(result.content, 'ok');
assert.equal(preparedRequests.length, 1);
assert.equal(preparedRequests[0].modelKey, 'kmodel_latest');
assert.equal(preparedRequests[0].modelSource, 'system');
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://example.test/agent_chat_generation');
assert.doesNotMatch(requests[0].url, /\/model\/v1\/chat\/completions/);
assert.equal(requests[0].headers.Authorization, 'Bearer isolated-test-token');
console.log('isolated prepared route passed');
