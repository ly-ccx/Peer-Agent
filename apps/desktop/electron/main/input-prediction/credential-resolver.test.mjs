import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createLlmConfigStore } from '../llm-config-store.mjs';

// A real worker and subprocess protocol; no OS keychain or real credentials.
test('credential lookup is off the main thread, abortable and never grants a tool', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-credentials-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./fixtures/credential-lookup.test.sh', import.meta.url));
  const started = path.join(root, 'lookup-started');
  const release = path.join(root, 'lookup-release');
  const request = path.join(root, 'lookup-request.json');
  writeFileSync(path.join(root, '.prediction-credential-fixture'), '');
  const original = process.env.PEER_CREDENTIAL_HELPER_PATH;
  process.env.PEER_CREDENTIAL_HELPER_PATH = helper;
  t.after(() => { if (original === undefined) delete process.env.PEER_CREDENTIAL_HELPER_PATH; else process.env.PEER_CREDENTIAL_HELPER_PATH = original; });
  const models = createLlmConfigStore({ configFile: path.join(root, 'models.json'), credentialDataHome: root,
    credentialClient: { setSecret() {}, getSecret() { return 'fixture'; } } });
  models.addProvider({ provider: 'openai-compatible', name: 'worker', model: 'worker', apiKey: 'fixture', baseUrl: 'http://localhost/v1' });
  const provider = models.listProviders()[0], controller = new AbortController();
  const lookup = models.resolveCredentialAsync(provider, controller.signal);
  // Only the main thread can release the helper after it receives the request.
  const waitForHelper = async () => {
    const deadline = performance.now() + 2000;
    while (!existsSync(started) && performance.now() < deadline) await delay(10);
    assert.ok(existsSync(started), 'the actual credential helper is waiting for the main thread');
  };
  await Promise.race([
    waitForHelper(),
    lookup.then(() => assert.fail('lookup resolved before the main thread released the helper')),
  ]);
  assert.equal(JSON.parse(readFileSync(request, 'utf8')).action, 'get');
  writeFileSync(release, '');
  const credential = await lookup;
  assert.equal(credential.apiKey, 'worker-test-secret');
  const pending = models.resolveCredentialAsync(provider, controller.signal);
  controller.abort(); await assert.rejects(pending, /CANCELLED/);
});
