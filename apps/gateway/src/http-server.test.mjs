import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createGatewayHttpServer } from './http-server.mjs';
import { createAccountHttp } from './account-http.mjs';
import { createAccountSessions } from './account-sessions.mjs';

function call(port, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: body === null ? 'GET' : 'POST', headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('real loopback HTTP: identity × Origin plus Cookie roundtrip and logout', async t => {
  const sessions = createAccountSessions(':memory:');
  const ownerId = 'a'.repeat(64);
  const origin = 'https://peer.example';
  const handle = createAccountHttp({ origin, sessions,
    login: { async finish() { return { ownerId }; } }, // Test-only verified identity substitute.
    devices: { listDevices(id) { return id === ownerId ? [{ deviceId: 'mac' }] : []; } },
  });
  const server = createGatewayHttpServer({ origin, handle });
  const address = await server.listen();
  t.after(async () => { await server.close(); sessions.close(); });
  assert.equal(address.address, '127.0.0.1');
  const callback = await call(address.port, '/auth/callback', { host: 'peer.example' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers['set-cookie'].length, 2);
  const cookie = callback.headers['set-cookie'].find(v => v.startsWith('__Host-peer_session=')).split(';')[0];
  for (const identity of ['valid', 'missing']) {
    const response = await call(address.port, '/api/devices', { host: 'peer.example', ...(identity === 'valid' ? { cookie } : {}) });
    assert.equal(response.status, identity === 'valid' ? 200 : 401);
    for (const source of ['same', 'foreign']) {
      const logout = await call(address.port, '/auth/logout', { host: 'peer.example',
        origin: source === 'same' ? origin : 'https://other.example',
        ...(identity === 'valid' ? { cookie } : {}) }, '');
      assert.equal(logout.status, source === 'same' ? 204 : 403);
    }
  }
  assert.equal((await call(address.port, '/api/devices', { host: 'peer.example', cookie })).status, 401);
});

test('real HTTP rejects invalid Host and oversized body before application dispatch', async t => {
  let calls = 0;
  const server = createGatewayHttpServer({ origin: 'https://peer.example', handle: async request => {
    calls++; assert.equal(request.headers.get('x-forwarded-host'), null);
    return Response.json({ ok: true });
  } });
  const address = await server.listen(); t.after(() => server.close());
  for (const host of ['attacker.example', '127.0.0.1']) {
    assert.equal((await call(address.port, '/', { host, 'x-forwarded-host': 'peer.example' })).status, 400);
  }
  assert.equal((await call(address.port, '//attacker.example/', { host: 'peer.example' })).status, 400);
  assert.equal((await call(address.port, '/', { host: 'peer.example', 'content-length': '4097' }, 'x'.repeat(4097))).status, 413);
  assert.equal(calls, 0);
  assert.equal((await call(address.port, '/', { host: 'peer.example', 'x-forwarded-host': 'attacker.example' })).status, 200);
  assert.equal(calls, 1);
});
