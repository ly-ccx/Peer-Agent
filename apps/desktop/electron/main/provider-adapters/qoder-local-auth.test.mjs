import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  extractEmbeddedAuthWasmBytes,
  loadQoderLocalAuth,
  resolveQoderCliBinary,
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

  it('resolves the CLI executable independently from an explicit wasm binary', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-path-'));
    const cliPath = path.join(dir, 'qodercli');
    const wasmPath = path.join(dir, 'auth-wasm-container');
    writeFileSync(cliPath, 'cli');
    writeFileSync(wasmPath, 'wasm');
    try {
      assert.equal(await resolveQoderCliBinary({
        env: {
          PATH: '',
          QODER_AUTH_WASM_BINARY: wasmPath,
          QODER_CLI_PATH: cliPath,
        },
        homeDir: dir,
      }), cliPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds qodercli.exe on Windows PATH', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-windows-'));
    const cliPath = path.join(dir, 'qodercli.exe');
    writeFileSync(cliPath, 'cli');
    try {
      assert.equal(await resolveQoderCliBinary({
        env: { PATH: dir },
        homeDir: path.join(dir, 'home'),
        platform: 'win32',
      }), cliPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('maps missing local auth files to qoder_auth_not_found instead of bare ENOENT', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-auth-missing-'));
    try {
      await assert.rejects(
        () => loadQoderLocalAuth({
          env: {},
          homeDir: dir,
        }),
        (error) => {
          assert.equal(error.code, 'qoder_auth_not_found');
          assert.notEqual(error.message, 'ENOENT');
          assert.match(error.message, /not found|sign in|login/i);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can still load local auth when PEER_AGENT_HOST_NODE is set (host-node fallback path stays available)', async () => {
    // Smoke-check: with a real host node path, env token short-circuits before file IO.
    // Full EPERM fallback is covered by the Electron probe in verify.
    const hostNode = process.execPath;
    const auth = await loadQoderLocalAuth({
      env: {
        QODER_ACCESS_TOKEN: 'host-node-env-token',
        PEER_AGENT_HOST_NODE: hostNode,
      },
      homeDir: '/missing-home',
    });
    assert.equal(auth.token, 'host-node-env-token');
    assert.equal(auth.source, 'QODER_ACCESS_TOKEN');
  });
});
