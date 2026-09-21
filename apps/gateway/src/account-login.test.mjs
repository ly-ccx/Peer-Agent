import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Configuration, customFetch } from 'openid-client';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createAccountLogin, discoverAccountLogin } from './account-login.mjs';

function fixture(extra = {}) {
  const configuration = new Configuration({ issuer: 'https://id.example',
    authorization_endpoint: 'https://id.example/authorize', token_endpoint: 'https://id.example/token' }, 'peer');
  return createAccountLogin({ configuration, redirectUri: 'https://peer.example/auth/callback', allowedSubject: 'owner', ...extra });
}

test('real OIDC library constructs code flow with PKCE, state and nonce', async () => {
  const login = fixture(); const a = await login.begin(); const b = await login.begin();
  const url = new URL(a.url);
  assert.equal(url.origin, 'https://id.example');
  for (const [name, value] of Object.entries({ response_type: 'code', scope: 'openid',
    code_challenge_method: 'S256', redirect_uri: 'https://peer.example/auth/callback', client_id: 'peer' })) {
    assert.equal(url.searchParams.get(name), value);
  }
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('nonce'));
  assert.notEqual(url.searchParams.get('state'), new URL(b.url).searchParams.get('state'));
  assert.notEqual(a.browserBinding, b.browserBinding);
  assert.equal(url.href.includes(a.browserBinding), false);
});

for (const invalid of ['cookie', 'expired', 'origin', 'duplicate-state', 'unknown-state']) {
  test(`login-deny-${invalid}`, async () => {
    let now = 1000; const login = fixture({ now: () => now });
    const start = await login.begin(); const state = new URL(start.url).searchParams.get('state');
    const callback = new URL(`https://peer.example/auth/callback?code=unused&state=${state}`);
    if (invalid === 'expired') now = start.expiresAt;
    if (invalid === 'origin') callback.hostname = 'attacker.example';
    if (invalid === 'duplicate-state') callback.searchParams.append('state', state);
    if (invalid === 'unknown-state') callback.searchParams.set('state', 'unknown');
    await assert.rejects(login.finish(callback, invalid === 'cookie' ? 'wrong' : start.browserBinding), /LOGIN_DENIED/);
    if (invalid === 'cookie' || invalid === 'expired') {
      await assert.rejects(login.finish(callback, start.browserBinding), /LOGIN_DENIED/);
    }
  });
}

test('pending login capacity remains bounded across concurrent begins', async () => {
  const login = fixture({ capacity: 1 });
  const first = login.begin();
  await assert.rejects(login.begin(), /RATE_LIMITED/);
  await first;
});

// Test-only token endpoint. Production discovery retains its HTTPS transport.
for (const variant of ['valid', 'subject', 'issuer', 'audience', 'nonce', 'expired']) {
  test(`oidc-token-exchange-${variant}`, async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const config = new Configuration({ issuer: 'https://id.example',
      authorization_endpoint: 'https://id.example/authorize', token_endpoint: 'https://id.example/token' }, 'peer');
    let authUrl;
    let exchanges = 0;
    config[customFetch] = async (url, options) => {
      assert.equal(String(url), 'https://id.example/token');
      exchanges++;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code'), 'test-code');
      assert.equal(body.get('redirect_uri'), 'https://peer.example/auth/callback');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      const time = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://id.example', sub: 'owner', aud: 'peer',
        iat: time, exp: time + 300, nonce: authUrl.searchParams.get('nonce') };
      if (variant === 'subject') claims.sub = 'other';
      if (variant === 'issuer') claims.iss = 'https://other.example';
      if (variant === 'audience') claims.aud = 'other-client';
      if (variant === 'nonce') claims.nonce = 'wrong';
      if (variant === 'expired') claims.exp = time - 3600;
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
      const jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
      return Response.json({ access_token: 'test-access', token_type: 'Bearer', id_token: jwt });
    };
    const login = createAccountLogin({ configuration: config, redirectUri: 'https://peer.example/auth/callback', allowedSubject: 'owner' });
    const start = await login.begin(); authUrl = new URL(start.url);
    const callback = `https://peer.example/auth/callback?code=test-code&state=${authUrl.searchParams.get('state')}`;
    if (variant === 'valid') {
      const identity = await login.finish(callback, start.browserBinding);
      assert.equal(identity.subject, 'owner');
      assert.equal(identity.ownerId, createHash('sha256').update(JSON.stringify(['https://id.example', 'owner'])).digest('hex'));
      assert.deepEqual(Object.keys(identity).sort(), ['issuer', 'ownerId', 'subject']);
    } else await assert.rejects(login.finish(callback, start.browserBinding));
    assert.equal(exchanges, 1);
    await assert.rejects(login.finish(callback, start.browserBinding), /LOGIN_DENIED/);
    assert.equal(exchanges, 1, 'replay never exchanges the code again');
  });
}

test('discovery does not permit insecure issuer', async () => {
  await assert.rejects(discoverAccountLogin({ issuer: 'http://id.example', clientId: 'peer' }), /INVALID_ISSUER/);
  assert.throws(() => fixture({ redirectUri: 'http://peer.example/auth/callback' }), /INVALID_LOGIN_CONFIG/);
});
