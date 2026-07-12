import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ModelCredentialNotFoundError,
  resolveOpenAICompatibleProviderConfig,
  type ModelCredentialPort,
} from './model-provider-contracts.ts';

test('resolves OpenAI-compatible config through the credential port', async () => {
  const requests: unknown[] = [];
  const credentials: ModelCredentialPort = {
    async resolve(request) {
      requests.push(request);
      return {
        apiKey: 'secret-value',
        baseUrl: 'https://example.test/v1',
        organizationId: 'org-1',
        headers: { 'X-Provider': 'peer' },
      };
    },
  };

  const config = await resolveOpenAICompatibleProviderConfig({
    providerId: 'openai-compatible',
    profileId: 'work',
    credentials,
  });

  assert.deepEqual(requests, [{ providerId: 'openai-compatible', profileId: 'work' }]);
  assert.deepEqual(config, {
    providerId: 'openai-compatible',
    apiKey: 'secret-value',
    baseUrl: 'https://example.test/v1',
    organizationId: 'org-1',
    headers: { 'X-Provider': 'peer' },
  });
});

test('uses the standard OpenAI base URL without coupling credential storage', async () => {
  const config = await resolveOpenAICompatibleProviderConfig({
    providerId: 'openai',
    credentials: { async resolve() { return { apiKey: 'secret-value' }; } },
  });

  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
});

test('reports missing credentials without exposing secret storage details', async () => {
  await assert.rejects(
    resolveOpenAICompatibleProviderConfig({
      providerId: 'openai',
      credentials: { async resolve() { return null; } },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelCredentialNotFoundError);
      assert.equal(error.providerId, 'openai');
      assert.doesNotMatch(error.message, /safeStorage|environment|keychain/i);
      return true;
    },
  );
});
