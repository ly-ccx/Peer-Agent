import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createMcpCredentialStore, resolveMcpCredentialInjection } from './mcp-credential-store.mjs';

let tmpDir;

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, ''),
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-credential-store-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function createStore() {
  return createMcpCredentialStore({
    credentialFile: path.join(tmpDir, 'mcp-credentials.json'),
    safeStorage: fakeSafeStorage,
  });
}

describe('MCP credential store', () => {
  it('stores encrypted credential values and returns only redacted metadata', () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'GitHub MCP token',
      kind: 'http_bearer',
      secret: 'ghp_super_secret_token',
    });

    assert.equal(credential.kind, 'http_bearer');
    assert.equal(credential.lastFour, 'oken');
    assert.equal(credential.storage, 'safeStorage');
    assert.ok(credential.credentialRef.startsWith('mcp-cred:'));
    assert.equal('secret' in credential, false);

    const persisted = readFileSync(path.join(tmpDir, 'mcp-credentials.json'), 'utf8');
    assert.equal(persisted.includes('ghp_super_secret_token'), false);
    assert.equal(persisted.includes('encrypted:'), false);

    const resolved = store.resolveSecret(credential.credentialRef);
    assert.equal(resolved.secret, 'ghp_super_secret_token');
  });

  it('injects HTTP bearer credentials as Authorization headers', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'Bearer',
      kind: 'http_bearer',
      secret: 'bearer-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'http_bearer',
      credentialRef: credential.credentialRef,
    }, { transport: 'streamable_http' });

    assert.deepEqual(injection.headers, { Authorization: 'Bearer bearer-secret' });
    assert.deepEqual(injection.env, {});
    assert.equal(injection.authContext.mode, 'http_bearer');
    assert.equal(injection.authContext.hasCredential, true);
  });

  it('injects custom HTTP header credentials', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'API key',
      kind: 'http_header',
      headerName: 'X-API-Key',
      secret: 'api-key-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'http_header',
      credentialRef: credential.credentialRef,
      headerName: 'X-API-Key',
    }, { transport: 'sse' });

    assert.deepEqual(injection.headers, { 'X-API-Key': 'api-key-secret' });
    assert.equal(injection.authContext.headerName, 'X-API-Key');
  });

  it('injects stdio credentials as process environment variables only for stdio transports', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'stdio env',
      kind: 'stdio_env',
      envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      secret: 'stdio-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'stdio_env',
      credentialRef: credential.credentialRef,
      envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    }, { transport: 'stdio' });

    assert.deepEqual(injection.headers, {});
    assert.deepEqual(injection.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'stdio-secret' });
    assert.equal(injection.authContext.envName, 'GITHUB_PERSONAL_ACCESS_TOKEN');

    await assert.rejects(
      () => resolveMcpCredentialInjection(store, {
        mode: 'stdio_env',
        credentialRef: credential.credentialRef,
        envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      }, { transport: 'streamable_http' }),
      /requires a stdio MCP transport/,
    );
  });

  it('stores OAuth tokens encrypted and exposes only token status in metadata', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'OAuth MCP',
      kind: 'oauth2',
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scopes: ['mcp.read'],
        redirectUrl: 'http://127.0.0.1:33418/mcp/oauth/callback',
      },
    });

    assert.equal(credential.kind, 'oauth2');
    assert.equal(credential.oauth.authorizationServerUrl, 'https://auth.example.com/');
    assert.equal(credential.oauth.clientSecretConfigured, true);
    assert.equal(credential.oauth.tokenStatus, 'missing');
    assert.equal('secret' in credential, false);

    store.updateOAuthCredential(credential.credentialRef, {
      tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 4102444800000 },
      clientInformation: { client_id: 'client-id', client_secret: 'registered-secret' },
      codeVerifier: 'pkce-secret',
    });

    const metadata = store.getCredential(credential.credentialRef);
    assert.equal(metadata.oauth.tokenStatus, 'available');
    assert.equal(metadata.oauth.expiresAt, new Date(4102444800000).toISOString());
    assert.equal(JSON.stringify(metadata).includes('access-secret'), false);
    assert.equal(JSON.stringify(metadata).includes('refresh-secret'), false);

    const persisted = readFileSync(path.join(tmpDir, 'mcp-credentials.json'), 'utf8');
    assert.equal(persisted.includes('access-secret'), false);
    assert.equal(persisted.includes('refresh-secret'), false);
    assert.equal(persisted.includes('registered-secret'), false);

    const oauthCredential = store.getOAuthCredential(credential.credentialRef);
    assert.equal(oauthCredential.oauth.tokens.access_token, 'access-secret');
    assert.equal(oauthCredential.oauth.clientInformation.client_secret, 'registered-secret');
  });

  it('injects OAuth authProvider config without headers or env', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'OAuth MCP',
      kind: 'oauth2',
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        clientId: 'client-id',
        scopes: ['mcp.read'],
      },
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'oauth2',
      credentialRef: credential.credentialRef,
    }, { transport: 'streamable_http' });

    assert.deepEqual(injection.headers, {});
    assert.deepEqual(injection.env, {});
    assert.equal(injection.authContext.mode, 'oauth2');
    assert.equal(injection.authContext.hasCredential, true);
    assert.equal(injection.authProviderConfig.credentialRef, credential.credentialRef);
    assert.equal(injection.authProviderConfig.oauth.clientId, 'client-id');
    assert.equal(typeof injection.authProviderConfig.updateOAuth, 'function');
  });
});
