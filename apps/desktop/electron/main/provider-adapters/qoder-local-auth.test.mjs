import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractEmbeddedAuthWasmBytes,
  loadQoderLocalAuth,
  resolveQoderConfigDir,
} from './qoder-local-auth.mjs';

describe('qoder local auth', () => {
  it('uses an explicit environment token before reading local auth files', async () => {
    const auth = await loadQoderLocalAuth({
      env: { QODER_ACCESS_TOKEN: 'env-token' },
      homeDir: '/missing-home',
    });

    assert.deepEqual(auth, {
      token: 'env-token',
      source: 'QODER_ACCESS_TOKEN',
      userInfo: null,
    });
  });

  it('resolves Qoder config dir using QODER_CONFIG_DIR first', () => {
    assert.equal(
      resolveQoderConfigDir({
        env: { QODER_CONFIG_DIR: '/tmp/qoder-config', QODER_CLI_HOME: '/tmp/qoder-home' },
        homeDir: '/home/user',
      }),
      '/tmp/qoder-config',
    );
  });

  it('falls back to QODER_CLI_HOME/.qoder', () => {
    assert.equal(
      resolveQoderConfigDir({
        env: { QODER_CLI_HOME: '/tmp/qoder-home' },
        homeDir: '/home/user',
      }),
      '/tmp/qoder-home/.qoder',
    );
  });

  it('extracts auth wasm from historical MsC and minified G9_ variable names', () => {
    const payload = `AGFzb${'A'.repeat(1200)}`;
    const legacy = `prefix;var MsC="${payload}";suffix`;
    const modern = `prefix;var G9_="${payload}";suffix`;

    const legacyBytes = extractEmbeddedAuthWasmBytes(legacy);
    const modernBytes = extractEmbeddedAuthWasmBytes(modern);

    assert.ok(legacyBytes);
    assert.ok(modernBytes);
    assert.equal(legacyBytes.length, modernBytes.length);
    assert.equal(legacyBytes.toString('base64'), Buffer.from(payload, 'base64').toString('base64'));
  });

  it('prefers the longest embedded wasm base64 payload when multiple matches exist', () => {
    const shortPayload = `AGFzb${'B'.repeat(1200)}`;
    const longPayload = `AGFzb${'C'.repeat(2400)}`;
    const content = `var short_="${shortPayload}";var long_="${longPayload}";`;
    const bytes = extractEmbeddedAuthWasmBytes(content);
    assert.ok(bytes);
    assert.equal(bytes.toString('base64'), Buffer.from(longPayload, 'base64').toString('base64'));
  });

  it('returns null when embedded wasm marker is missing', () => {
    assert.equal(extractEmbeddedAuthWasmBytes('var MsC="not-wasm-payload";'), null);
    assert.equal(extractEmbeddedAuthWasmBytes(''), null);
  });
});
