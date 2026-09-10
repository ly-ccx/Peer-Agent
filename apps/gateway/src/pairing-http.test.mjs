import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAccountHttp } from './account-http.mjs';
import { createAccountSessions } from './account-sessions.mjs';
import { createDeviceStore } from './device-store.mjs';
const origin = 'https://peer.example';
const ownerId = 'a'.repeat(64);
function setup(t) {
  const sessions = createAccountSessions(':memory:');
  const devices = createDeviceStore(':memory:');
  t.after(() => { sessions.close(); devices.close(); });
  const pair = devices.beginPairing({ name: 'Mac', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  const token = sessions.issue({ ownerId }).token;
  const handler = createAccountHttp({ origin, sessions, devices, login: {} });
  const send = (body, headers = {}) => handler(new Request(origin + '/api/pairings/claim', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `__Host-peer_session=${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { sessions, devices, pair, token, send };
}
for (const auth of ['valid', 'missing', 'revoked']) {
  for (const key of ['valid', 'wrong', 'consumed']) {
    test(`pairing-http-${auth}-${key}`, async t => {
      const f = setup(t);
      if (auth === 'revoked') f.sessions.revoke(f.token);
      if (key === 'consumed') f.devices.claimPairing(ownerId, f.pair.challengeId, f.pair.pairingKey);
      const response = await f.send({ challengeId: f.pair.challengeId, pairingKey: key === 'wrong' ? 'wrong' : f.pair.pairingKey },
        auth === 'missing' ? { cookie: '' } : {});
      assert.equal(response.status, auth !== 'valid' ? 401 : key === 'valid' ? 202 : 400);
      if (response.status === 202) {
        assert.equal((await response.json()).status, 'awaiting_device_ack');
        assert.equal(f.devices.listDevices(ownerId).length, 1);
      }
    });
  }
}
test('claim rejects cross-origin, oversized, malformed and identity-injected requests; limits attempts', async t => {
  const f = setup(t);
  const body = { challengeId: f.pair.challengeId, pairingKey: f.pair.pairingKey };
  assert.equal((await f.send(body, { origin: 'https://other.example' })).status, 403);
  assert.equal((await f.send('x'.repeat(4097))).status, 413);
  assert.equal((await f.send('{')).status, 400);
  assert.equal((await f.send({ ...body, ownerId: 'b'.repeat(64) })).status, 400);
  assert.equal((await f.send(body, { 'content-type': 'text/plain' })).status, 415);
  for (let i = 0; i < 6; i++) assert.equal((await f.send('{}')).status, 400);
  assert.equal((await f.send(body)).status, 429);
  assert.equal(f.devices.listDevices(ownerId).length, 0);
});
