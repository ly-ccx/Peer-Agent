import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createLlmConfigStore } from './llm-config-store.mjs';

function withStore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llm-config-store-'));
  const configFile = path.join(dir, 'llm-providers.json');
  try {
    return fn({ dir, configFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('subscription provider creation applies gpt-5.5 pricing and context metadata', () => withStore(({ configFile }) => {
  const store = createLlmConfigStore({ configFile });
  const provider = store.addProvider({ provider: 'openai', authMethod: 'oauth_chatgpt' });

  assert.equal(provider.model, 'gpt-5.5');
  assert.equal(provider.contextWindow, 1_050_000);
  assert.equal(provider.inputPrice, 5);
  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.outputPrice, 30);
  assert.equal(provider.cacheWritePrice, undefined);
  assert.equal(provider.longContextInputThreshold, 272_000);
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
  assert.equal(provider.contextWindow, 1_050_000);
  assert.equal(provider.inputPrice, 5);
  assert.equal(provider.cacheReadPrice, 0.5);
  assert.equal(provider.outputPrice, 30);
  assert.equal(provider.cacheWritePrice, undefined);
  assert.equal(provider.longContextOutputPrice, 45);
  assert.equal(provider.supportsReasoning, true);
  assert.equal(provider.supportsPromptCaching, true);

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'))[0];
  assert.equal(persisted.contextWindow, 1_050_000);
  assert.equal(persisted.inputPrice, 5);
  assert.equal(persisted.cacheWritePrice, undefined);
}));
