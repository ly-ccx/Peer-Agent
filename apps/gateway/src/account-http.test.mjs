import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountHttp } from './account-http.mjs';
import { createAccountSessions } from './account-sessions.mjs';

const origin = 'https://peer.example';
const ownerId = 'a'.repeat(64);
function setup(t) {
  const sessions = createAccountSessions(':memory:'); t.after(() => sessions.close());
  const handler = createAccountHttp({ origin, sessions,
    // Only a test double; production must use account-login's verified OIDC result.
    login: { async begin() { return { url: 'https://id.example/authorize', browserBinding: 'binding' }; },
      async finish(url, binding) { if (binding !== 'binding') throw new Error('secret-error'); return { ownerId }; } },
    devices: { listDevices(id) { return id === ownerId ? [{ deviceId: 'mac' }] : []; } },
  });
  const request = (path, options = {}) => handler(new Request(origin + path, options));
  return { sessions, request };
}

for (const session of ['valid', 'missing', 'revoked', 'duplicate-cookie']) {
  test(`http-devices-${session}`, async t => {
    const { sessions, request } = setup(t); const token = sessions.issue({ ownerId }).token;
    if (session === 'revoked') sessions.revoke(token);
    const headers = {};
    if (session !== 'missing') headers.cookie = `__Host-peer_session=${token}`;
    if (session === 'duplicate-cookie') headers.cookie += `; __Host-peer_session=${token}`;
    const response = await request('/api/devices?ownerId=attacker', { headers });
    assert.equal(response.status, session === 'valid' ? 200 : 401);
    if (session === 'valid') assert.deepEqual(await response.json(), { devices: [{ deviceId: 'mac' }] });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
}

test('login callback issues protected cookie; logout affects only that session', async t => {
  const { sessions, request } = setup(t);
  const other = sessions.issue({ ownerId });
  const start = await request('/auth/login', { method: 'POST', headers: { origin } });
  assert.equal(start.status, 303);
  assert.match(start.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const result = await request('/auth/callback?code=test&state=test', { headers: { cookie: '__Host-peer_login=binding' } });
  assert.equal(result.status, 303);
  const cookies = result.headers.getSetCookie();
  const sessionCookie = cookies.find(v => v.startsWith('__Host-peer_session='));
  assert.ok(sessionCookie); assert.ok(cookies.some(v => v.startsWith('__Host-peer_login=;')));
  const header = sessionCookie.split(';')[0];
  assert.equal((await request('/api/devices', { headers: { cookie: header } })).status, 200);
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { origin, cookie: header } })).status, 204);
  assert.equal((await request('/api/devices', { headers: { cookie: header } })).status, 401);
  assert.equal(sessions.authenticate(other.token).ownerId, ownerId);
});

for (const route of ['/auth/login', '/auth/logout']) {
  for (const source of ['absent', 'foreign']) {
    test(`http-origin-${route}-${source}`, async t => {
      const { request } = setup(t);
      const headers = source === 'foreign' ? { origin: 'https://attacker.example' } : {};
      assert.equal((await request(route, { method: 'POST', headers })).status, 403);
    });
  }
}

test('Host mismatch and failed callbacks never expose sensitive details', async t => {
  const { request } = setup(t);
  assert.equal((await request('/api/devices', { headers: { host: 'attacker.example' } })).status, 400);
  const denied = await request('/auth/callback?code=sensitive');
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: 'LOGIN_DENIED' });
  assert.match(denied.headers.get('set-cookie'), /Max-Age=0/);
});
