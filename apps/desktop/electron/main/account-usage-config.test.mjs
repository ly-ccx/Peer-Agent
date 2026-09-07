import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmConfigStore } from './llm-config-store.mjs';

for (const authMethod of ['api_key', 'oauth_chatgpt']) test(`config/account-revision/${authMethod}/change-reload-no-secret-projection`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'account-revision-'));
  const secrets = new Map();
  const options = { configFile: path.join(dir, 'providers.json'), credentialClient: {
    getSecret: (key) => secrets.get(key) ?? null,
    setSecret: (key, value) => secrets.set(key, String(value)),
    deleteSecret: (key) => secrets.delete(key),
  } };
  try {
    const store = createLlmConfigStore(options);
    const created = store.addProvider({ provider: 'openai', authMethod, model: 'gpt-6-astra', ...(authMethod === 'api_key' ? { apiKey: 'secret-original-value' } : {}) });
    const view = () => store.listProviders().find((p) => p.id === created.id);
    const first = view().accountUsageRevision;
    assert.ok(first);
    assert.equal(view().accountUsageRevision, first);
    if (authMethod === 'api_key') store.updateProvider(created.id, { apiKey: 'secret-replacement-value' });
    else store.setOAuthTokens(created.id, { access: 'secret-original-value', refresh: 'refresh', expires: Date.now() + 600000, accountId: 'account-one' });
    const second = view().accountUsageRevision;
    assert.notEqual(second, first);
    if (authMethod === 'oauth_chatgpt') {
      store.setOAuthTokens(created.id, { access: 'secret-replacement-value', refresh: 'refresh', expires: Date.now() + 600000, accountId: 'account-two' });
      assert.notEqual(view().accountUsageRevision, second);
    }
    assert.ok(!JSON.stringify(view()).includes('secret-replacement-value'));
    const persisted = readFileSync(options.configFile, 'utf8');
    assert.ok(!persisted.includes('accountUsageRevision'));
    assert.ok(!persisted.includes('secret-replacement-value'));
    const reloaded = createLlmConfigStore(options).listProviders().find((p) => p.id === created.id);
    assert.notEqual(reloaded.accountUsageRevision, view().accountUsageRevision);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
