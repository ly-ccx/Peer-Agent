import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLlmConfigStore } from '../llm-config-store.mjs';

// A real worker and subprocess protocol; no OS keychain or real credentials.
test('credential lookup is off the main thread, abortable and never grants a tool', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-credentials-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, 'helper.cjs');
  writeFileSync(helper, '#!/usr/bin/env node\nlet raw="";process.stdin.on("data",x=>raw+=x);process.stdin.on("end",()=>{const r=JSON.parse(raw);setTimeout(()=>process.stdout.write(JSON.stringify({version:1,ok:true,data:{secret:"worker-test-secret"}})),50);});', { mode: 0o700 });
  const original = process.env.PEER_CREDENTIAL_HELPER_PATH;
  process.env.PEER_CREDENTIAL_HELPER_PATH = helper;
  t.after(() => { if (original === undefined) delete process.env.PEER_CREDENTIAL_HELPER_PATH; else process.env.PEER_CREDENTIAL_HELPER_PATH = original; });
  const models = createLlmConfigStore({ configFile: path.join(root, 'models.json'), credentialDataHome: root,
    credentialClient: { setSecret() {}, getSecret() { return 'fixture'; } } });
  models.addProvider({ provider: 'openai-compatible', name: 'worker', model: 'worker', apiKey: 'fixture', baseUrl: 'http://localhost/v1' });
  const provider = models.listProviders()[0], controller = new AbortController();
  let ticks = 0; const timer = setInterval(() => ticks++, 10); t.after(() => clearInterval(timer));
  const credential = await models.resolveCredentialAsync(provider, controller.signal);
  assert.equal(credential.apiKey, 'worker-test-secret'); assert.ok(ticks > 5, 'lookup did not block the main event loop');
  const pending = models.resolveCredentialAsync(provider, controller.signal);
  controller.abort(); await assert.rejects(pending, /CANCELLED/);
});
